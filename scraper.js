// scraper.js — SaiuVaga (Supabase + Evolution API + Mercado Pago)
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
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

// ── WhatsApp via Baileys (direto, sem Evolution API) ─────────
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

let waSocket = null;
let waReady = false;
let waQRCode = null;
const AUTH_PATH = path.join('/tmp', 'baileys_auth');
const SUPABASE_BUCKET = 'baileys-session';
const SUPABASE_SESSION_FILE = 'creds.json';

// ── Salva sessão Baileys no Supabase Storage ─────────────────
async function salvarSessaoSupabase() {
  try {
    const credsPath = path.join(AUTH_PATH, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    const conteudo = fs.readFileSync(credsPath);
    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(SUPABASE_SESSION_FILE, conteudo, { upsert: true, contentType: 'application/json' });
    if (error) console.log('   ⚠️ Erro ao salvar sessão no Supabase:', error.message);
    else console.log('   💾 Sessão WhatsApp salva no Supabase!');
  } catch (err) {
    console.log('   ⚠️ salvarSessaoSupabase:', err.message);
  }
}

// ── Restaura sessão Baileys do Supabase Storage ──────────────
async function restaurarSessaoSupabase() {
  try {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .download(SUPABASE_SESSION_FILE);
    if (error || !data) {
      console.log('   ℹ️ Nenhuma sessão salva encontrada — aguardando QR code.');
      return false;
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    fs.writeFileSync(path.join(AUTH_PATH, 'creds.json'), buffer);
    console.log('   ✅ Sessão WhatsApp restaurada do Supabase!');
    return true;
  } catch (err) {
    console.log('   ⚠️ restaurarSessaoSupabase:', err.message);
    return false;
  }
}

async function iniciarBaileys() {
  if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });

  // Tenta restaurar sessão salva antes de pedir QR
  await restaurarSessaoSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['SaiuVaga', 'Chrome', '124.0'],
  });

  sock.ev.on('creds.update', () => {
    saveCreds();
    // Sincroniza credenciais atualizadas com Supabase (fire-and-forget)
    salvarSessaoSupabase().catch(e => console.log('⚠️ creds.update save:', e.message));
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      waQRCode = qr;
      console.log('\n📱 QR DISPONÍVEL EM: https://saiuvaga-production.up.railway.app/qr\n');
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp conectado via Baileys! connection=open');
      waReady = true;
      waQRCode = null;
      waSocket = sock;
      // Salva sessão no Supabase para sobreviver a restarts
      await salvarSessaoSupabase();
    }
    if (connection === 'close') {
      waReady = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('⚠️ WhatsApp desconectado. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(iniciarBaileys, 5000);
    }
  });

  // Recebe mensagens e encaminha para o chatbot
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`📨 messages.upsert type=${type} count=${messages.length}`);
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid.includes('@g.us')) continue;

      const remoteJid = msg.key.remoteJid; // JID original para responder
      const phone = remoteJid
        .replace('@s.whatsapp.net', '')
        .replace('@c.us', '')
        .replace('@lid', '')
        .split(':')[0];
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || ''
      ).trim();

      if (!phone || !text) continue;
      console.log(`\n💬 WhatsApp de ${phone} (jid=${remoteJid}): "${text}"`);
      await processarMensagem(remoteJid, text); // usa JID original para responder
    }
  });
}

// Inicia Baileys ao subir o servidor
iniciarBaileys().catch(console.error);

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
app.get('/', (req, res) => res.json({ status: 'SaiuVaga online ✅', whatsapp: waReady ? 'conectado' : 'aguardando QR' }));

// ── Rota QR Code WhatsApp ────────────────────────────────────
app.get('/qr', async (req, res) => {
  if (waReady) return res.send('<h2>✅ WhatsApp já está conectado!</h2>');
  if (!waQRCode) return res.send('<h2>⏳ Aguardando QR code... recarregue em 5 segundos.</h2><script>setTimeout(()=>location.reload(),5000)</script>');

  try {
    const QRCode = require('qrcode');
    const qrImage = await QRCode.toDataURL(waQRCode);
    res.send(`
      <!DOCTYPE html><html><head><title>SaiuVaga — Conectar WhatsApp</title>
      <meta http-equiv="refresh" content="30">
      <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff}
      img{width:300px;border:4px solid #25d366;border-radius:12px;padding:10px;background:#fff}</style></head>
      <body>
        <h2>📱 Escaneie com o WhatsApp</h2>
        <p>Abra o WhatsApp → Configurações → Aparelhos vinculados → Vincular aparelho</p>
        <img src="${qrImage}" alt="QR Code"/>
        <p><small>Esta página recarrega automaticamente a cada 30s</small></p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Erro ao gerar QR: ' + err.message);
  }
});

// ── Função WhatsApp unificada (Baileys direto) ───────────────
async function enviarWhatsApp(telefone, imovel = null, mensagemLivre = null) {
  const mensagem = mensagemLivre || (
    `🚨 *Nova vaga — ${imovel.bairro}!*\n\n` +
    `🏠 ${imovel.titulo}\n` +
    `💰 R$ ${imovel.preco.toLocaleString('pt-BR')}/mês\n` +
    `📍 ${imovel.bairro}, SP\n` +
    `🔗 ${imovel.link}\n\n` +
    `_Responda PARAR para cancelar alertas_`
  );

  // Se já é um JID completo (contém @), usa direto; senão monta o JID
  const jid = telefone.includes('@')
    ? telefone
    : (telefone.replace(/\D/g, '').startsWith('55') ? telefone.replace(/\D/g, '') : `55${telefone.replace(/\D/g, '')}`) + '@s.whatsapp.net';
  console.log(`   📲 Enviando para JID: ${jid}`);

  if (!waReady || !waSocket) {
    console.log(`   ⚠️ WhatsApp não conectado ainda — mensagem não enviada para ${telefone}`);
    return false;
  }

  try {
    await waSocket.sendMessage(jid, { text: mensagem });
    console.log(`   📲 WhatsApp enviado para ${telefone}`);
    return true;
  } catch (err) {
    console.error(`   ✗ Erro Baileys: ${err.message}`);
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

// ── Função de processar mensagem (usada pelo Baileys e webhook) ─
async function processarMensagem(phone, text) {
  try {
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
    const mensagem = data.choices?.[0]?.message?.content;
    if (!mensagem) return;

    await enviarWhatsApp(phone, null, mensagem);
    console.log(`   🤖 Resposta enviada para ${phone}`);
  } catch (err) {
    console.error('❌ Erro chatbot:', err.message);
  }
}

// Webhook mantido para compatibilidade (não é mais necessário com Baileys)
app.post('/api/whatsapp/webhook', async (req, res) => {
  res.sendStatus(200);
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
// SCRAPER MODULAR — ZAP + VivaReal + MercadoLivre + ImovelWeb
// Todas as fontes rodam em paralelo com fallback automático
// Usa ScraperAPI como proxy rotativo residencial para bypassar 403
// ─────────────────────────────────────────────────────────────

// ── Helper ScraperAPI ─────────────────────────────────────────
// Envolve qualquer URL com o proxy da ScraperAPI (IPs residenciais)
// Fallback automático: se SCRAPERAPI_KEY não estiver definida, faz requisição direta
function scraperApiUrl(targetUrl) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return targetUrl; // sem proxy se não tiver key
  return `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(targetUrl)}`;
}

// Faz request via ScraperAPI com headers customizados
async function axiosProxy(url, headers = {}, timeout = 25000) {
  const key = process.env.SCRAPERAPI_KEY;
  if (key) {
    // Via ScraperAPI: envia a URL como parâmetro, headers via query params não funcionam
    // então usamos o modo direto com headers injetados pelo proxy
    const proxyUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&keep_headers=true`;
    return axios.get(proxyUrl, { headers, timeout });
  }
  // Fallback direto
  return axios.get(url, { headers, timeout });
}

const BUSCAS = [
  { bairro: 'Pinheiros',     region: 'pinheiros'     },
  { bairro: 'Vila Madalena', region: 'vila-madalena' },
  { bairro: 'Faria Lima',    region: 'faria-lima'    },
  { bairro: 'Moema',         region: 'moema'         },
  { bairro: 'Itaim Bibi',    region: 'itaim-bibi'    },
];

// Converte bairro para slug de URL
function toSlug(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// ── SOURCE 1: ZAP Imóveis ────────────────────────────────────
async function buscarZap(bairro) {
  const slug = toSlug(bairro);
  const url = `https://glue-api.zapimoveis.com.br/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=24&from=0`;
  const { data } = await axiosProxy(url, {
    'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'x-domain': 'www.zapimoveis.com.br', 'Origin': 'https://www.zapimoveis.com.br',
  }, 25000);
  return (data?.search?.result?.listings || [])
    .filter(i => i?.listing?.pricingInfos?.[0]?.price)
    .map(i => ({
      titulo: i.listing.title || `Imóvel - ${bairro}`,
      preco: parseInt(i.listing.pricingInfos[0].price) || 0,
      bairro, tipo: 'residencial', portal: 'ZAP',
      link: `https://www.zapimoveis.com.br${i.link?.href || ''}`,
    }))
    .filter(i => i.preco > 0 && i.link.length > 30);
}

// ── SOURCE 2: VivaReal ────────────────────────────────────────
async function buscarVivaReal(bairro) {
  const slug = toSlug(bairro);
  const url = `https://glue-api.vivareal.com.br/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=24&from=0`;
  const { data } = await axiosProxy(url, {
    'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'x-domain': 'www.vivareal.com.br', 'Origin': 'https://www.vivareal.com.br',
  }, 45000);
  return (data?.search?.result?.listings || [])
    .filter(i => i?.listing?.pricingInfos?.[0]?.price)
    .map(i => ({
      titulo: i.listing.title || `Imóvel - ${bairro}`,
      preco: parseInt(i.listing.pricingInfos[0].price) || 0,
      bairro, tipo: 'residencial', portal: 'VivaReal',
      link: `https://www.vivareal.com.br${i.link?.href || ''}`,
    }))
    .filter(i => i.preco > 0 && i.link.length > 30);
}

// ── SOURCE 3: Mercado Livre Imóveis (API oficial pública) ─────
async function buscarMercadoLivre(bairro) {
  // ML tem API pública oficial — proxy ajuda a evitar rate limit por IP de datacenter
  const url = `https://api.mercadolibre.com/sites/MLB/search?category=MLB1459&q=${encodeURIComponent(bairro + ' aluguel SP')}&limit=20`;
  const { data } = await axiosProxy(url, { 'Accept': 'application/json' }, 45000);
  return (data?.results || [])
    .filter(i => i.price && i.title && i.permalink)
    .map(i => ({
      titulo: i.title,
      preco: parseInt(i.price) || 0,
      bairro, tipo: 'residencial', portal: 'MercadoLivre',
      link: i.permalink.split('?')[0],
    }))
    .filter(i => i.preco > 0);
}

// ── SOURCE 4: ImovelWeb (RSS feed público) ────────────────────
async function buscarImovelWeb(bairro) {
  const slug = toSlug(bairro);
  const url = `https://www.imovelweb.com.br/imoveis-aluguel-sao-paulo-sp-${slug}.rss`;
  const { data: xml } = await axiosProxy(url, {
    'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, text/xml',
  }, 45000);
  const $ = cheerio.load(xml, { xmlMode: true });
  const imoveis = [];
  $('item').each((_, el) => {
    const titulo = $(el).find('title').text().trim();
    const link = $(el).find('link').text().trim() || $(el).find('guid').text().trim();
    const desc = $(el).find('description').text();
    const precoMatch = desc.match(/R\$[\s]?([\d.,]+)/) || titulo.match(/R\$[\s]?([\d.,]+)/);
    const preco = precoMatch ? parseInt(precoMatch[1].replace(/\D/g, '')) : 0;
    if (titulo && link && preco > 0) {
      imoveis.push({ titulo, preco, bairro, tipo: 'residencial', portal: 'ImovelWeb', link: link.split('?')[0] });
    }
  });
  return imoveis;
}

// ── FUNÇÃO PRINCIPAL: todas as fontes em paralelo ─────────────
async function buscarOLX(bairro, region) {
  console.log(`\n🔍 Buscando imóveis: ${bairro}`);

  // Roda todas as fontes em paralelo — se uma falha, as outras continuam
  const resultados = await Promise.allSettled([
    buscarZap(bairro),
    buscarVivaReal(bairro),
    buscarMercadoLivre(bairro),
    buscarImovelWeb(bairro),
  ]);

  const fontes = ['ZAP', 'VivaReal', 'MercadoLivre', 'ImovelWeb'];
  const todos = [];

  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      console.log(`   ✓ ${r.value.length} imóveis via ${fontes[i]}`);
      todos.push(...r.value);
    } else {
      const err = r.status === 'rejected' ? r.reason?.message : 'sem resultados';
      console.log(`   ⚠️ ${fontes[i]}: ${err}`);
    }
  });

  const unicos = [...new Map(todos.map(i => [i.link, i])).values()];
  console.log(`   📦 Total: ${unicos.length} imóveis únicos de ${bairro}`);
  return unicos;
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
