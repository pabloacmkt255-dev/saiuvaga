// scraper.js — SaiuVaga (Apify + Supabase + Evolution API + Mercado Pago)
require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

// ── Clientes ────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const mp = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// ── Config Evolution API ─────────────────────────────────────
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-b0b4a.up.railway.app';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || 'saiuvaga2024evolution';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'saiuvaga';

// ── Servidor Express ────────────────────────────────────────
const app = express();
app.use(express.json());

// ── CORS ────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🌐 Servidor rodando na porta ${PORT}`));

// ── Rota de saúde ───────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'SaiuVaga online ✅' }));

// ── Função WhatsApp unificada (Evolution API) ────────────────
async function enviarWhatsApp(telefone, imovel = null, mensagemLivre = null) {
  const mensagem = mensagemLivre || (
    `🚨 *Nova vaga — ${imovel.bairro}!*\n\n` +
    `🏠 ${imovel.titulo}\n` +
    `💰 R$ ${imovel.preco.toLocaleString('pt-BR')}/mês\n` +
    `📍 ${imovel.bairro}, SP\n` +
    `🔗 ${imovel.link}\n\n` +
    `_Responda PARAR para cancelar alertas_`
  );

  const numero = telefone.replace(/\D/g, '');
  const numeroFormatado = numero.startsWith('55') ? numero : `55${numero}`;

  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        number: numeroFormatado,
        text: mensagem,
      },
      {
        headers: {
          'apikey': EVOLUTION_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    console.log(`   📲 WhatsApp enviado para ${telefone}`);
    return true;
  } catch (err) {
    console.error(`   ✗ Erro Evolution API: ${err.message}`);
    return false;
  }
}

// ── Ativar trial de 7 dias ──────────────────────────────────
app.post('/api/trial/ativar', async (req, res) => {
  try {
    const { user_id, email } = req.body;
    if (!user_id && !email) return res.status(400).json({ erro: 'user_id ou email obrigatório' });

    const query = user_id
      ? supabase.from('users').select('id, trial_usado, ativo, plano_validade').eq('id', user_id).maybeSingle()
      : supabase.from('users').select('id, trial_usado, ativo, plano_validade').eq('email', email).maybeSingle();

    const { data: user } = await query;

    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado' });
    if (user.trial_usado) return res.status(400).json({ erro: 'Trial já utilizado', ja_usou: true });
    if (user.ativo) return res.status(400).json({ erro: 'Usuário já possui plano ativo' });

    const validade = new Date();
    validade.setDate(validade.getDate() + 7);

    await supabase.from('users').update({
      ativo: true,
      trial_usado: true,
      plano_validade: validade.toISOString(),
      plano: 'trial',
    }).eq('id', user.id);

    console.log(`   🎁 Trial ativado para ${email || user_id} até ${validade.toLocaleDateString('pt-BR')}`);

    res.json({
      ok: true,
      mensagem: 'Trial de 7 dias ativado!',
      validade: validade.toISOString(),
      dias: 7,
    });

  } catch (err) {
    console.error('❌ Erro trial:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Verificar status do usuário ─────────────────────────────
app.get('/api/usuario/status', async (req, res) => {
  try {
    const { user_id, email } = req.query;
    if (!user_id && !email) return res.status(400).json({ erro: 'user_id ou email obrigatório' });

    const query = user_id
      ? supabase.from('users').select('id, ativo, trial_usado, plano, plano_validade').eq('id', user_id).maybeSingle()
      : supabase.from('users').select('id, ativo, trial_usado, plano, plano_validade').eq('email', email).maybeSingle();

    const { data: user } = await query;
    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const agora = new Date();
    const validade = user.plano_validade ? new Date(user.plano_validade) : null;
    const ativo = user.ativo && validade && validade > agora;

    if (user.ativo && validade && validade <= agora) {
      await supabase.from('users').update({ ativo: false }).eq('id', user.id);
    }

    const diasRestantes = validade ? Math.max(0, Math.ceil((validade - agora) / (1000*60*60*24))) : 0;

    res.json({
      ativo,
      plano: user.plano,
      trial_usado: user.trial_usado,
      validade: user.plano_validade,
      dias_restantes: diasRestantes,
      em_trial: user.plano === 'trial' && ativo,
    });

  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Gerar Pix ───────────────────────────────────────────────
app.post('/api/pagamento/pix', async (req, res) => {
  try {
    const { email, nome, cpf, plano = 'mensal' } = req.body;

    if (!email || !nome || !cpf) {
      return res.status(400).json({ erro: 'email, nome e cpf são obrigatórios' });
    }

    const valores = { mensal: 19.90, trimestral: 38.00 };
    const valor = valores[plano] || 19.90;

    const payment = new Payment(mp);
    const result = await payment.create({
      body: {
        transaction_amount: valor,
        description: `SaiuVaga — Plano ${plano}`,
        payment_method_id: 'pix',
        payer: {
          email,
          first_name: nome.split(' ')[0],
          last_name: nome.split(' ').slice(1).join(' ') || '-',
          identification: { type: 'CPF', number: cpf.replace(/\D/g, '') },
        },
      },
    });

    const pix = result.point_of_interaction?.transaction_data;

    res.json({
      id: result.id,
      status: result.status,
      qr_code: pix?.qr_code,
      qr_code_base64: pix?.qr_code_base64,
      copia_cola: pix?.qr_code,
      expiracao: pix?.ticket_url,
      valor,
      plano,
    });

  } catch (err) {
    console.error('❌ Erro Pix:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Gerar Boleto ────────────────────────────────────────────
app.post('/api/pagamento/boleto', async (req, res) => {
  try {
    const { email, nome, cpf, cep, plano = 'mensal' } = req.body;

    if (!email || !nome || !cpf || !cep) {
      return res.status(400).json({ erro: 'email, nome, cpf e cep são obrigatórios' });
    }

    const valores = { mensal: 19.90, trimestral: 38.00 };
    const valor = valores[plano] || 19.90;

    const payment = new Payment(mp);
    const result = await payment.create({
      body: {
        transaction_amount: valor,
        description: `SaiuVaga — Plano ${plano}`,
        payment_method_id: 'bolbradesco',
        payer: {
          email,
          first_name: nome.split(' ')[0],
          last_name: nome.split(' ').slice(1).join(' ') || '-',
          identification: { type: 'CPF', number: cpf.replace(/\D/g, '') },
          address: { zip_code: cep.replace(/\D/g, '') },
        },
      },
    });

    res.json({
      id: result.id,
      status: result.status,
      boleto_url: result.transaction_details?.external_resource_url,
      codigo_barras: result.barcode?.content,
      data_vencimento: result.date_of_expiration,
      valor,
      plano,
    });

  } catch (err) {
    console.error('❌ Erro Boleto:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Gerar Cartão de Crédito (Checkout Pro) ──────────────────
app.post('/api/pagamento/cartao', async (req, res) => {
  try {
    const { email, nome, plano = 'mensal', user_id } = req.body;

    if (!email) {
      return res.status(400).json({ erro: 'email é obrigatório' });
    }

    const valores = { mensal: 19.90, trimestral: 38.00 };
    const valor = valores[plano] || 19.90;

    const preference = new Preference(mp);
    const result = await preference.create({
      body: {
        items: [{
          title: `SaiuVaga — Plano ${plano}`,
          quantity: 1,
          unit_price: valor,
          currency_id: 'BRL',
        }],
        payer: { email, name: nome },
        back_urls: {
          success: 'https://saiuvaga.com.br/sucesso.html',
          failure: 'https://saiuvaga.com.br/erro.html',
          pending: 'https://saiuvaga.com.br/pendente.html',
        },
        auto_return: 'approved',
        external_reference: user_id || email,
        notification_url: 'https://saiuvaga-production.up.railway.app/api/webhook/mp',
      },
    });

    res.json({
      preference_id: result.id,
      checkout_url: result.init_point,
      sandbox_url: result.sandbox_init_point,
      valor,
      plano,
    });

  } catch (err) {
    console.error('❌ Erro Cartão:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Webhook Mercado Pago ────────────────────────────────────
app.post('/api/webhook/mp', async (req, res) => {
  res.sendStatus(200);

  try {
    const { type, data } = req.body;
    console.log(`\n📩 Webhook MP: type=${type} id=${data?.id}`);

    if (type !== 'payment' || !data?.id) return;

    const payment = new Payment(mp);
    const pag = await payment.get({ id: data.id });

    console.log(`   Status: ${pag.status} | Valor: R$${pag.transaction_amount} | Email: ${pag.payer?.email}`);

    if (pag.status !== 'approved') return;

    const email = pag.payer?.email;
    if (!email) return;

    const { data: user } = await supabase
      .from('users')
      .select('id, whatsapp, nome')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      console.log(`   ⚠️  Usuário não encontrado para ${email}`);
      return;
    }

    const diasPlano = pag.transaction_amount >= 35 ? 90 : 30;
    const validade = new Date();
    validade.setDate(validade.getDate() + diasPlano);

    await supabase
      .from('users')
      .update({
        ativo: true,
        plano_validade: validade.toISOString(),
        ultimo_pagamento: new Date().toISOString(),
        mp_payment_id: String(pag.id),
      })
      .eq('id', user.id);

    console.log(`   ✅ Usuário ${email} ativado por ${diasPlano} dias`);

    if (user.whatsapp) {
      await enviarWhatsApp(
        user.whatsapp,
        null,
        `✅ *Pagamento confirmado!*\n\n` +
        `Olá ${user.nome || ''}! Seu acesso ao SaiuVaga foi ativado.\n` +
        `📅 Válido por ${diasPlano} dias.\n\n` +
        `Você receberá alertas de imóveis assim que houver novidades! 🏠`
      );
    }

  } catch (err) {
    console.error('❌ Erro webhook:', err.message);
  }
});

// ── Webhook WhatsApp (Evolution API) ────────────────────────
app.get('/api/whatsapp/webhook', (req, res) => {
  res.json({ ok: true, status: 'SaiuVaga Chatbot ativo ✅' });
});

app.post('/api/whatsapp/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    // Formato Evolution API v2
    const remoteJid = body?.data?.key?.remoteJid || body?.data?.remoteJid || '';

    // Ignora grupos e mensagens próprias logo no início
    if (body?.data?.key?.fromMe) return;
    if (remoteJid.includes('@g.us')) return;

    // Extrai phone — suporta @s.whatsapp.net e @lid
    const phone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '')
      || body?.phone
      || body?.from;

    const text = (
      body?.data?.message?.conversation ||
      body?.data?.message?.extendedTextMessage?.text ||
      body?.data?.message?.imageMessage?.caption ||
      body?.message?.conversation ||
      body?.text?.message ||
      body?.body || ''
    ).trim();

    console.log(`\n📩 Webhook recebido — phone=${phone} text="${text}"`);

    if (!phone || !text) {
      console.log(`   ⚠️ phone ou text vazio, ignorando`);
      return;
    }

    console.log(`\n💬 WhatsApp de ${phone}: "${text}"`);

    // Busca dados do usuário no Supabase
    const numero = phone.replace(/\D/g, '').replace(/^55/, '');
    const { data: user } = await supabase
      .from('users')
      .select('nome, email, ativo, trial_usado, plano, plano_validade')
      .ilike('whatsapp', `%${numero}%`)
      .maybeSingle();

    const agora = new Date();
    const validade = user?.plano_validade ? new Date(user.plano_validade) : null;
    const ativo = user?.ativo && validade && validade > agora;
    const diasRestantes = validade ? Math.max(0, Math.ceil((validade - agora) / (1000*60*60*24))) : 0;

    let contextoUsuario = 'Usuário não cadastrado no SaiuVaga.';
    if (user) {
      if (ativo && user.plano === 'trial') {
        contextoUsuario = `Usuário cadastrado: ${user.nome || 'sem nome'}. Status: trial ativo com ${diasRestantes} dias restantes.`;
      } else if (ativo) {
        contextoUsuario = `Usuário cadastrado: ${user.nome || 'sem nome'}. Status: plano ${user.plano} ativo com ${diasRestantes} dias restantes.`;
      } else if (user.trial_usado) {
        contextoUsuario = `Usuário cadastrado: ${user.nome || 'sem nome'}. Status: trial expirado, aguardando pagamento.`;
      } else {
        contextoUsuario = `Usuário cadastrado: ${user.nome || 'sem nome'}. Status: cadastrado mas ainda não ativou o trial.`;
      }
    }

    const prompt = `Você é o assistente virtual do SaiuVaga, um serviço de alertas de imóveis em tempo real via WhatsApp em São Paulo.

INFORMAÇÕES DO PRODUTO:
- Monitora +100 portais (OLX, ZAP, Viva Real e outros) 24 horas por dia
- Avisa o usuário no WhatsApp em menos de 2 minutos quando surge um imóvel com seus critérios
- Trial gratuito: 7 dias, sem cartão de crédito
- Plano Mensal: R$19/mês
- Plano Trimestral: R$38/3 meses (1 mês grátis)
- Site: saiuvaga.com.br
- Para cadastrar: saiuvaga.com.br/saiuvaga-cadastro.html

CONTEXTO DO USUÁRIO ATUAL:
${contextoUsuario}

REGRAS:
- Responda em português brasileiro, de forma simpática e direta
- Máximo 3 parágrafos curtos — WhatsApp é informal
- Use emojis com moderação
- Se não souber responder, diga que vai verificar e peça para aguardar
- Não invente informações sobre o produto
- Se perguntarem sobre preço, sempre mencione o trial gratuito primeiro
- Se o trial expirou, incentive o pagamento gentilmente
- Nunca seja robótico — seja humano e empático

MENSAGEM DO USUÁRIO:
${text}

Responda como assistente do SaiuVaga:`;

    const resposta = await fetch(
      `https://api.groq.com/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.7,
        }),
      }
    );

    const data = await resposta.json();
    console.log('   🤖 Groq raw:', JSON.stringify(data).slice(0, 200));
    const mensagem = data.choices?.[0]?.message?.content;

    if (!mensagem) {
      console.log('   ⚠️ Groq não respondeu — erro:', data?.error?.message || 'sem choices');
      return;
    }

    await enviarWhatsApp(phone, null, mensagem);
    console.log(`   🤖 Resposta enviada para ${phone}`);

  } catch (err) {
    console.error('❌ Erro chatbot:', err.message);
  }
});

// ── Rota para criar instância Evolution API ──────────────────
app.post('/api/evolution/criar-instancia', async (req, res) => {
  try {
    const result = await axios.post(
      `${EVOLUTION_URL}/instance/create`,
      {
        instanceName: EVOLUTION_INSTANCE,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      },
      {
        headers: {
          'apikey': EVOLUTION_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Rota para obter QR Code ──────────────────────────────────
app.get('/api/evolution/qrcode', async (req, res) => {
  try {
    const result = await axios.get(
      `${EVOLUTION_URL}/instance/connect/${EVOLUTION_INSTANCE}`,
      {
        headers: { 'apikey': EVOLUTION_KEY },
      }
    );
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Rota para status da instância ───────────────────────────
app.get('/api/evolution/status', async (req, res) => {
  try {
    const result = await axios.get(
      `${EVOLUTION_URL}/instance/fetchInstances`,
      {
        headers: { 'apikey': EVOLUTION_KEY },
      }
    );
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SCRAPER — Apify Brazil Real Estate Scraper (OLX, ZAP, VivaReal)
// ─────────────────────────────────────────────────────────────

const BUSCAS = [
  { bairro: 'Pinheiros',     region: 'pinheiros'     },
  { bairro: 'Vila Madalena', region: 'vila-madalena' },
  { bairro: 'Faria Lima',    region: 'faria-lima'    },
];

async function buscarOLX(bairro, region) {
  console.log(`\n🔍 Buscando: ${bairro}`);

  if (!process.env.APIFY_TOKEN) {
    console.log('   ⚠️  APIFY_TOKEN não configurado');
    return [];
  }

  try {
    const run = await axios.post(
      `https://api.apify.com/v2/acts/leadercorp~olx-imoveis-scraper/runs`,
      {
        urlsIniciais: [{
          url: `https://www.olx.com.br/imoveis/aluguel/estado-sp?q=${encodeURIComponent(bairro)}`
        }],
        coletarDetalhesAnuncio: false,
        incluirDescricao: false,
        incluirFotos: false,
        incluirDadosAnunciante: false,
        pararCedoSemNovosItens: true,
        correspondenciaEstrita: false,
        depurar: false,
        fallbackPlaywright: false,
        usarProxiesResidenciais: false,
        configuracaoProxy: { useApifyProxy: true },
      },
      {
        headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` },
        params: { waitForFinish: 120 },
        timeout: 130000,
      }
    );

    const datasetId = run.data?.data?.defaultDatasetId;
    if (!datasetId) {
      console.log('   ⚠️  datasetId não retornado');
      return [];
    }

    const results = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items`,
      { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } }
    );

    const imoveis = (results.data || [])
      .filter(item => item.preco && item.titulo && item.url)
      .map(item => ({
        titulo: item.titulo,
        preco: parseInt(String(item.preco).replace(/\D/g, '')) || 0,
        bairro,
        tipo: 'residencial',
        portal: 'OLX',
        link: (item.url || '').split('?')[0],
      }))
      .filter(i => i.preco > 0 && i.link);

    console.log(`   ✓ ${imoveis.length} imóveis encontrados`);
    return imoveis;

  } catch (err) {
    console.error(`   ✗ Erro Apify: ${err.message}`);
    return [];
  }
}

async function salvarImoveis(imoveis) {
  if (imoveis.length === 0) return 0;

  const { data, error } = await supabase
    .from('imoveis')
    .upsert(imoveis, { onConflict: 'link', ignoreDuplicates: true })
    .select();

  if (error) { console.error('   ✗ Erro ao salvar:', error.message); return 0; }
  const novos = data ? data.length : 0;
  if (novos > 0) console.log(`   💾 ${novos} imóveis novos salvos!`);
  return novos;
}

async function verificarAlertas() {
  const { data: filtros } = await supabase
    .from('filtros')
    .select('*, users(whatsapp, ativo)')
    .eq('ativo', true);

  if (!filtros || filtros.length === 0) return;

  for (const filtro of filtros) {
    const whatsapp = filtro.users?.whatsapp;
    if (!whatsapp || !filtro.users?.ativo) continue;

    const { data: matches } = await supabase
      .from('imoveis')
      .select('*')
      .ilike('bairro', `%${filtro.bairro}%`)
      .lte('preco', filtro.preco_max)
      .gte('encontrado_em', new Date(Date.now() - 10 * 60 * 1000).toISOString());

    if (!matches || matches.length === 0) continue;

    for (const imovel of matches) {
      const { data: jaEnviado } = await supabase
        .from('alertas')
        .select('id')
        .eq('user_id', filtro.user_id)
        .eq('imovel_id', imovel.id)
        .maybeSingle();

      if (jaEnviado) continue;

      await supabase.from('alertas').insert({
        user_id: filtro.user_id,
        filtro_id: filtro.id,
        imovel_id: imovel.id,
      });

      await enviarWhatsApp(whatsapp, imovel);
      console.log(`   🔔 Alerta: ${imovel.titulo} → ${whatsapp}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function rodarScraper() {
  console.log(`\n🚀 SaiuVaga — ${new Date().toLocaleString('pt-BR')}`);
  let total = 0;

  for (const b of BUSCAS) {
    const imoveis = await buscarOLX(b.bairro, b.region);
    total += await salvarImoveis(imoveis);
    await new Promise(r => setTimeout(r, 2000));
  }

  await verificarAlertas();
  console.log(`\n✅ Concluído! ${total} novos imóveis salvos.\n`);
}

// ── Manter Evolution API acordada ───────────────────────────
cron.schedule('*/10 * * * *', async () => {
  try {
    await axios.get(`${EVOLUTION_URL}/instance/fetchInstances`, {
      headers: { 'apikey': EVOLUTION_KEY },
      timeout: 5000,
    });
    console.log('   💓 Evolution API ping OK');
  } catch (err) {
    console.log('   💤 Evolution API ping falhou:', err.message);
  }
});

cron.schedule('*/5 * * * *', rodarScraper);
rodarScraper();
