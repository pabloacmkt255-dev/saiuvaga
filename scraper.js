// scraper.js — SaiuVaga (Apify + Supabase + Z-API + Mercado Pago)
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

// ── Gerar Pix ───────────────────────────────────────────────
app.post('/api/pagamento/pix', async (req, res) => {
  try {
    const { email, nome, cpf, plano = 'mensal' } = req.body;

    if (!email || !nome || !cpf) {
      return res.status(400).json({ erro: 'email, nome e cpf são obrigatórios' });
    }

    const valores = { mensal: 19.90, trimestral: 49.90, anual: 149.90 };
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

    const valores = { mensal: 19.90, trimestral: 49.90, anual: 149.90 };
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

    const valores = { mensal: 19.90, trimestral: 49.90, anual: 149.90 };
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
  res.sendStatus(200); // responde rápido pro MP não retentar

  try {
    const { type, data } = req.body;
    console.log(`\n📩 Webhook MP: type=${type} id=${data?.id}`);

    if (type !== 'payment' || !data?.id) return;

    // Busca detalhes do pagamento
    const payment = new Payment(mp);
    const pag = await payment.get({ id: data.id });

    console.log(`   Status: ${pag.status} | Valor: R$${pag.transaction_amount} | Email: ${pag.payer?.email}`);

    if (pag.status !== 'approved') return;

    const email = pag.payer?.email;
    if (!email) return;

    // Atualiza usuário como ativo no Supabase
    const { data: user } = await supabase
      .from('users')
      .select('id, whatsapp, nome')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      console.log(`   ⚠️  Usuário não encontrado para ${email}`);
      return;
    }

    // Calcula validade conforme valor pago
    const diasPlano = pag.transaction_amount >= 140 ? 365
      : pag.transaction_amount >= 45 ? 90 : 30;

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

    // Envia WhatsApp de confirmação
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

// ─────────────────────────────────────────────────────────────
// SCRAPER (sem alterações)
// ─────────────────────────────────────────────────────────────

const BUSCAS = [
  { bairro: 'Pinheiros',     tipo: 'residencial' },
  { bairro: 'Vila Madalena', tipo: 'residencial' },
  { bairro: 'Faria Lima',    tipo: 'comercial'   },
];

async function buscarApify(bairro, tipo) {
  console.log(`\n🔍 Buscando: ${bairro}`);

  if (!process.env.APIFY_TOKEN) {
    console.log('   ⚠️  APIFY_TOKEN não configurado');
    return [];
  }

  try {
    const run = await axios.post(
      `https://api.apify.com/v2/acts/epctex~olx-scraper/runs`,
      {
        startUrls: [{
          url: `https://www.olx.com.br/imoveis/aluguel/estado-sp?q=${encodeURIComponent(bairro)}`
        }],
        maxItems: 20,
      },
      {
        headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` },
        params: { waitForFinish: 120 },
        timeout: 130000,
      }
    );

    const datasetId = run.data?.data?.defaultDatasetId;
    if (!datasetId) return [];

    const results = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items`,
      { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } }
    );

    const imoveis = (results.data || [])
      .filter(item => item.price && item.title && item.url)
      .map(item => ({
        titulo: item.title,
        preco: parseInt(String(item.price).replace(/\D/g, '')) || 0,
        bairro,
        tipo,
        portal: 'OLX',
        link: item.url.split('?')[0],
      }))
      .filter(i => i.preco > 0);

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

// Função WhatsApp unificada (alerta de imóvel ou mensagem livre)
async function enviarWhatsApp(telefone, imovel = null, mensagemLivre = null) {
  if (!process.env.ZAPI_INSTANCE || !process.env.ZAPI_TOKEN) {
    console.log('   ⚠️  Z-API não configurado');
    return false;
  }

  const mensagem = mensagemLivre || (
    `🚨 *Nova vaga — ${imovel.bairro}!*\n\n` +
    `🏠 ${imovel.titulo}\n` +
    `💰 R$ ${imovel.preco.toLocaleString('pt-BR')}/mês\n` +
    `📍 ${imovel.bairro}, SP\n` +
    `🔗 ${imovel.link}\n\n` +
    `_Responda PARAR para cancelar alertas_`
  );

  try {
    await axios.post(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`,
      { phone: telefone, message: mensagem },
      { timeout: 10000 }
    );
    console.log(`   📲 WhatsApp enviado para ${telefone}`);
    return true;
  } catch (err) {
    console.error(`   ✗ Erro Z-API: ${err.message}`);
    return false;
  }
}

async function verificarAlertas() {
  const { data: filtros } = await supabase
    .from('filtros')
    .select('*, users(whatsapp, ativo)')
    .eq('ativo', true);

  if (!filtros || filtros.length === 0) return;

  for (const filtro of filtros) {
    const whatsapp = filtro.users?.whatsapp;
    // Só envia alerta se usuário está ativo (pagou)
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
    const imoveis = await buscarApify(b.bairro, b.tipo);
    total += await salvarImoveis(imoveis);
    await new Promise(r => setTimeout(r, 2000));
  }

  await verificarAlertas();
  console.log(`\n✅ Concluído! ${total} novos imóveis salvos.\n`);
}

cron.schedule('*/5 * * * *', rodarScraper);
rodarScraper();
