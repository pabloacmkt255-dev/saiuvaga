// scraper.js - SaiuVaga (Z-API WhatsApp + Supabase + Mercado Pago)
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

// -- Clientes ------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const mp = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// -- Z-API WhatsApp -------------------------------------------
const ZAPI_INSTANCE    = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN       = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || ZAPI_TOKEN; // Token de segurança do cliente Z-API
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'saiuvaga_webhook_2024';

async function enviarWhatsApp(telefone, imovel = null, mensagemLivre = null) {
  const mensagem = mensagemLivre || (
    `🚨 *Nova vaga - ${imovel.bairro}!*\n\n` +
    `🏠 ${imovel.titulo}\n` +
    `💰 R$ ${imovel.preco.toLocaleString('pt-BR')}/mes\n` +
    `📍 ${imovel.bairro}, SP\n` +
    `🔗 ${imovel.link}\n\n` +
    `_Responda PARAR para cancelar alertas_`
  );

  let phone = telefone.replace(/\D/g, '');
  if (!phone.startsWith('55')) phone = '55' + phone;

  try {
    const res = await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      { phone, message: mensagem },
      {
        headers: {
          'Content-Type': 'application/json',
          'Client-Token': ZAPI_CLIENT_TOKEN
        }
      }
    );
    console.log(`   📲 WhatsApp enviado para ${phone} | id: ${res.data?.zaapId || res.data?.messageId}`);
    return true;
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    console.error(`   _ Erro Z-API: ${detail}`);
    return false;
  }
}

// -- Servidor Express ----------------------------------------
const app = express();

// -- CORS ----------------------------------------------------
const ALLOWED_ORIGINS = [
  'https://saiuvaga.com.br',
  'https://www.saiuvaga.com.br',
  'http://localhost:3000', // dev local
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Guarda o raw body para validacao do webhook do MP
app.use((req, res, next) => {
  if (req.path === '/api/webhook/mp') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      try { req.body = JSON.parse(data); } catch(e) { req.body = {}; }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🌐 Servidor rodando na porta ${PORT}`));

// -- Rota de saude -------------------------------------------
app.get('/', (req, res) => res.json({
  status: 'SaiuVaga online ✅',
  whatsapp: 'Z-API ativa',
  zapi_instance: ZAPI_INSTANCE ? '✅ configurado' : '❌ faltando'
}));

// -- Webhook Z-API - receber mensagens ------------------------
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body || body.fromMe) return;
    const from = body.phone;
    const text = body.text?.message || body.message || '';
    if (!from || !text) return;
    console.log(`\n💬 WhatsApp de ${from}: "${text}"`);
    await processarMensagem(from, text);
  } catch (err) {
    console.error('❌ Erro webhook:', err.message);
  }
});

// -- Webhook GET (compatibilidade) ---------------------------
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(200);
  }
});

// -- Funcao de processar mensagem (chatbot Groq) --------------
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

    let contextoUsuario = 'Usuario nao cadastrado no SaiuVaga.';
    if (user) {
      if (ativo && user.plano === 'trial') {
        contextoUsuario = `Usuario cadastrado: ${user.nome || 'sem nome'}. Status: trial ativo com ${diasRestantes} dias restantes.`;
      } else if (ativo) {
        contextoUsuario = `Usuario cadastrado: ${user.nome || 'sem nome'}. Status: plano ${user.plano} ativo com ${diasRestantes} dias restantes.`;
      } else if (user.trial_usado) {
        contextoUsuario = `Usuario cadastrado: ${user.nome || 'sem nome'}. Status: trial expirado, aguardando pagamento.`;
      } else {
        contextoUsuario = `Usuario cadastrado: ${user.nome || 'sem nome'}. Status: cadastrado mas ainda nao ativou o trial.`;
      }
    }

    const prompt = `Voce e o assistente virtual do SaiuVaga, um servico de alertas de imoveis em tempo real via WhatsApp em Sao Paulo.

INFORMACOES DO PRODUTO:
- Monitora +100 portais (OLX, ZAP, Viva Real e outros) 24 horas por dia
- Avisa o usuario no WhatsApp em menos de 2 minutos quando surge um imovel com seus criterios
- Trial gratuito: 7 dias, sem cartao de credito
- Plano Mensal: R$19/mes
- Plano Trimestral: R$38/3 meses (1 mes gratis)
- Site: saiuvaga.com.br
- Para cadastrar: saiuvaga.com.br/saiuvaga-cadastro.html

CONTEXTO DO USUARIO ATUAL:
${contextoUsuario}

REGRAS:
- Responda em portugues brasileiro, de forma simpatica e direta
- Maximo 3 paragrafos curtos - WhatsApp e informal
- Use emojis com moderacao
- Se nao souber responder, diga que vai verificar e peca para aguardar
- Nao invente informacoes sobre o produto
- Se perguntarem sobre preco, sempre mencione o trial gratuito primeiro
- Se o trial expirou, incentive o pagamento gentilmente
- Nunca seja robotico - seja humano e empatico

MENSAGEM DO USUARIO:
${text}

Responda como assistente do SaiuVaga:`;

    const resposta = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.7,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        }
      }
    );

    const mensagem = resposta.data?.choices?.[0]?.message?.content;
    if (!mensagem) return;

    await enviarWhatsApp(phone, null, mensagem);
    console.log(`   🤖 Resposta enviada para ${phone}`);
  } catch (err) {
    console.error('❌ Erro chatbot:', err.message);
  }
}

// -- Ativar trial de 7 dias ----------------------------------
app.post('/api/trial/ativar', async (req, res) => {
  try {
    const { user_id, email } = req.body;
    if (!user_id && !email) return res.status(400).json({ erro: 'user_id ou email obrigatorio' });

    // Valida token de sessao Supabase - rejeita chamadas sem autenticacao valida
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ erro: 'Autenticacao obrigatoria' });

    const { data: { user: sessionUser }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !sessionUser) return res.status(401).json({ erro: 'Token invalido ou expirado' });

    // Garante que o token pertence ao mesmo usuario da requisicao
    if (user_id && sessionUser.id !== user_id) return res.status(403).json({ erro: 'Acesso negado' });
    if (email && sessionUser.email !== email) return res.status(403).json({ erro: 'Acesso negado' });

    const query = user_id
      ? supabase.from('users').select('id, trial_usado, ativo, plano_validade').eq('id', user_id).maybeSingle()
      : supabase.from('users').select('id, trial_usado, ativo, plano_validade').eq('email', email).maybeSingle();

    const { data: user } = await query;

    if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });
    if (user.trial_usado) return res.status(400).json({ erro: 'Trial ja utilizado', ja_usou: true });
    if (user.ativo) return res.status(400).json({ erro: 'Usuario ja possui plano ativo' });

    const validade = new Date();
    validade.setDate(validade.getDate() + 7);

    await supabase.from('users').update({
      ativo: true,
      trial_usado: true,
      plano_validade: validade.toISOString(),
      plano: 'trial',
    }).eq('id', user.id);

    console.log(`   🎁 Trial ativado para ${email || user_id} ate ${validade.toLocaleDateString('pt-BR')}`);
    res.json({ ok: true, mensagem: 'Trial de 7 dias ativado!', validade: validade.toISOString(), dias: 7 });

  } catch (err) {
    console.error('❌ Erro trial:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// -- Verificar status do usuario -----------------------------
app.get('/api/usuario/status', async (req, res) => {
  try {
    const { user_id, email } = req.query;
    if (!user_id && !email) return res.status(400).json({ erro: 'user_id ou email obrigatorio' });

    const query = user_id
      ? supabase.from('users').select('id, ativo, trial_usado, plano, plano_validade').eq('id', user_id).maybeSingle()
      : supabase.from('users').select('id, ativo, trial_usado, plano, plano_validade').eq('email', email).maybeSingle();

    const { data: user } = await query;
    if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });

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

// -- Gerar Pix -----------------------------------------------
app.post('/api/pagamento/pix', async (req, res) => {
  try {
    const { email, nome, cpf, plano = 'mensal' } = req.body;
    if (!email || !nome || !cpf) return res.status(400).json({ erro: 'email, nome e cpf sao obrigatorios' });

    const valores = { mensal: 19.90, trimestral: 38.00 };
    const valor = valores[plano] || 19.90;

    const payment = new Payment(mp);
    const result = await payment.create({
      body: {
        transaction_amount: valor,
        description: `SaiuVaga - Plano ${plano}`,
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
      valor, plano,
    });

  } catch (err) {
    console.error('❌ Erro Pix:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// -- Gerar Boleto --------------------------------------------
app.post('/api/pagamento/boleto', async (req, res) => {
  try {
    const { email, nome, cpf, cep, plano = 'mensal' } = req.body;
    if (!email || !nome || !cpf || !cep) return res.status(400).json({ erro: 'email, nome, cpf e cep sao obrigatorios' });

    const valores = { mensal: 19.90, trimestral: 38.00 };
    const valor = valores[plano] || 19.90;

    const payment = new Payment(mp);
    const result = await payment.create({
      body: {
        transaction_amount: valor,
        description: `SaiuVaga - Plano ${plano}`,
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
      valor, plano,
    });

  } catch (err) {
    console.error('❌ Erro Boleto:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// -- Gerar Cartao --------------------------------------------
app.post('/api/pagamento/cartao', async (req, res) => {
  try {
    const { email, nome, user_id, plano = 'mensal' } = req.body;
    if (!email || !nome) return res.status(400).json({ erro: 'email e nome sao obrigatorios' });

    const valores = { mensal: 19.90, trimestral: 38.00 };
    const valor = valores[plano] || 19.90;

    const preference = new Preference(mp);
    const result = await preference.create({
      body: {
        items: [{
          title: `SaiuVaga - Plano ${plano}`,
          quantity: 1,
          unit_price: valor,
          currency_id: 'BRL',
        }],
        payer: { email, name: nome },
        back_urls: {
          success: 'https://saiuvaga.com.br/confirmado.html',
          failure: 'https://saiuvaga.com.br/saiuvaga-pagamento.html?erro=1',
          pending: 'https://saiuvaga.com.br/saiuvaga-pagamento.html?pendente=1',
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
      valor, plano,
    });

  } catch (err) {
    console.error('❌ Erro Cartao:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// -- Webhook Mercado Pago ------------------------------------
app.post('/api/webhook/mp', async (req, res) => {
  // -- Validacao de assinatura Mercado Pago -----------------
  try {
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (secret) {
      const xSignature = req.headers['x-signature'] || '';
      const xRequestId  = req.headers['x-request-id'] || '';
      const urlParams   = new URLSearchParams(req.originalUrl.split('?')[1] || '');
      const dataId      = urlParams.get('data.id') || '';

      const parts = {};
      xSignature.split(',').forEach(p => {
        const [k, v] = p.trim().split('=');
        if (k && v) parts[k] = v;
      });

      if (parts.ts && parts.v1) {
        const manifest = `id:${dataId};request-id:${xRequestId};ts:${parts.ts};`;
        const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
        if (hmac !== parts.v1) {
          console.warn('⚠_ Webhook MP: assinatura invalida - requisicao ignorada');
          return res.sendStatus(401);
        }
      }
    }
  } catch (sigErr) {
    console.error('❌ Erro validacao assinatura MP:', sigErr.message);
    return res.sendStatus(401);
  }

  res.sendStatus(200);
  try {
    const { type, data } = req.body;
    console.log(`\n📩 Webhook MP: type=${type} id=${data?.id}`);
    if (type !== 'payment' || !data?.id) return;

    // Busca o pagamento real na API do MP para garantir integridade
    const payment = new Payment(mp);
    const pag = await payment.get({ id: data.id });
    console.log(`   Status: ${pag.status} | Valor: R$${pag.transaction_amount} | Email: ${pag.payer?.email}`);
    if (pag.status !== 'approved') return;

    const email = pag.payer?.email;
    const externalRef = pag.external_reference; // user_id ou email, enviado pelo /api/pagamento/cartao

    let userQuery = email
      ? supabase.from('users').select('id, whatsapp, nome').eq('email', email).maybeSingle()
      : null;

    let { data: user } = userQuery ? await userQuery : { data: null };

    // Fallback: tenta pelo external_reference (cartão de crédito via Preference)
    if (!user && externalRef) {
      // Pode ser um UUID (user_id) ou email
      const isUUID = /^[0-9a-f-]{36}$/.test(externalRef);
      const q = isUUID
        ? supabase.from('users').select('id, whatsapp, nome').eq('id', externalRef).maybeSingle()
        : supabase.from('users').select('id, whatsapp, nome').eq('email', externalRef).maybeSingle();
      const { data: userRef } = await q;
      user = userRef;
    }

    if (!user) { console.log(`   ⚠️  Usuario nao encontrado para email=${email} ref=${externalRef}`); return; }

    const diasPlano = pag.transaction_amount >= 35 ? 90 : 30;
    const nomePlano = diasPlano === 90 ? 'trimestral' : 'mensal';
    const validade = new Date();
    validade.setDate(validade.getDate() + diasPlano);

    await supabase.from('users').update({
      ativo: true,
      plano: nomePlano,
      plano_validade: validade.toISOString(),
      ultimo_pagamento: new Date().toISOString(),
      mp_payment_id: String(pag.id),
    }).eq('id', user.id);

    console.log(`   ✅ Usuario ${email} ativado por ${diasPlano} dias`);

    if (user.whatsapp) {
      await enviarWhatsApp(
        user.whatsapp, null,
        `✅ *Pagamento confirmado!*\n\n` +
        `Ola ${user.nome || ''}! Seu acesso ao SaiuVaga foi ativado.\n` +
        `📅 Valido por ${diasPlano} dias.\n\n` +
        `Voce recebera alertas de imoveis assim que houver novidades! 🏠`
      );
    }
  } catch (err) {
    console.error('❌ Erro webhook MP:', err.message);
  }
});

// -- Rotas legadas -------------------------------------------
app.get('/api/whatsapp/webhook', (req, res) => res.json({ ok: true, status: 'SaiuVaga Z-API ativa ✅' }));
app.post('/api/whatsapp/webhook', (req, res) => res.sendStatus(200));

// -- Admin API (dashboard) ------------------------------------
// Valida senha via header Authorization: Bearer <senha>
// Usa supabaseAdmin (service_key) para ler todos os dados
const supabaseAdmin = require('@supabase/supabase-js')
  .createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'saiuvaga2024admin';

function verificarAdmin(req, res) {
  const auth = req.headers['authorization'] || '';
  const senha = auth.replace('Bearer ', '').trim();
  if (senha !== ADMIN_SECRET) {
    res.status(401).json({ erro: 'Acesso negado' });
    return false;
  }
  return true;
}

app.get('/api/admin/users', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .order('criado_em', { ascending: false });
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/admin/payments', async (req, res) => {
  if (!verificarAdmin(req, res)) return;
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('nome, email, plano, ultimo_pagamento, mp_payment_id, plano_validade')
      .not('ultimo_pagamento', 'is', null)
      .order('ultimo_pagamento', { ascending: false })
      .limit(10);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// -------------------------------------------------------------
// SCRAPER - Apify (principal) + ScraperAPI (fallback)
// -------------------------------------------------------------

// Busca imoveis via Apify actor fatihtahta/zap-imoveis-scraper
async function buscarViaApify(bairro) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return null;

  const slug = toSlug(bairro);
  const input = {
    location: `${bairro}, Sao Paulo`,
    limit: 48,
    maximize_coverage: false,
    below_market_price: false,
    near_transit: false,
  };

  try {
    // Dispara o actor e aguarda resultado
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/fatihtahta~zap-imoveis-scraper/run-sync-get-dataset-items?token=${token}&timeout=120&memory=256`,
      input,
      { headers: { 'Content-Type': 'application/json' }, timeout: 130000 }
    );

    const items = runRes.data || [];
    if (!Array.isArray(items) || items.length === 0) return [];

    return items
      .filter(i => {
        // Filtra apenas aluguel residencial
        const offers = i.pricing?.offers || [];
        const temAluguel = offers.some(o => o.business_type === 'rental');
        const residencial = i.attributes?.usage_types?.includes('residential');
        return temAluguel && residencial;
      })
      .map(i => {
        const ofertaAluguel = i.pricing.offers.find(o => o.business_type === 'rental');
        const preco = ofertaAluguel?.amount || 0;
        const titulo = i.content?.title || `Imovel - ${bairro}`;
        const link = i.source_context?.url || 'https://www.zapimoveis.com.br/';
        const bairroDado = i.location?.neighborhood || bairro;
        return { titulo, preco, bairro: bairroDado, tipo: 'residencial', portal: 'ZAP', link };
      })
      .filter(i => i.preco > 0 && i.link.length > 20);
  } catch (e) {
    console.log(`   __ Apify falhou para ${bairro}: ${e.message?.slice(0, 60)}`);
    return null; // null = tenta fallback
  }
}

async function axiosProxy(url, headers = {}, timeout = 45000) {
  const scraperApiKey = process.env.SCRAPERAPI_KEY;
  const scrapeDoKey   = process.env.SCRAPEDO_KEY;
  const brightDataKey = process.env.BRIGHTDATA_KEY;

  if (scraperApiKey) {
    try {
      const proxyUrl = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(url)}&country_code=br&keep_headers=true`;
      const res = await axios.get(proxyUrl, { headers, timeout });
      if (res.status >= 400) throw new Error(`status ${res.status}`);
      return res;
    } catch (e) {
      console.log(`   __ ScraperAPI falhou (${e.message.slice(0,50)}), tentando Scrape.do...`);
    }
  }

  if (scrapeDoKey) {
    try {
      const proxyUrl = `https://api.scrape.do?token=${scrapeDoKey}&url=${encodeURIComponent(url)}&geoCode=br`;
      const res = await axios.get(proxyUrl, { headers, timeout });
      if (res.status >= 400) throw new Error(`status ${res.status}`);
      return res;
    } catch (e) {
      console.log(`   __ Scrape.do falhou (${e.message.slice(0,50)}), tentando BrightData...`);
    }
  }

  if (brightDataKey) {
    try {
      const { HttpProxyAgent } = require('http-proxy-agent');
      const proxyAgent = new HttpProxyAgent(`http://brd-customer-hl_auto:${brightDataKey}@brd.superproxy.io:22225`);
      const res = await axios.get(url, { headers, timeout, httpAgent: proxyAgent, httpsAgent: proxyAgent });
      return res;
    } catch (e) {
      console.log(`   __ BrightData falhou (${e.message.slice(0,40)}), tentando direto...`);
    }
  }

  return axios.get(url, { headers, timeout });
}

// ─── VIVA REAL via ScraperAPI (DNS direto descontinuado) ─────────────────────
async function buscarVivaRealDireto(bairro) {
  const scraperKey = process.env.SCRAPERAPI_KEY;
  const slug = toSlug(bairro);
  const targetUrl = `https://www.vivareal.com.br/aluguel/sao-paulo/sao-paulo/bairros/${slug}/?__vt=t`;
  // Tenta via ScraperAPI para contornar o bloqueio de geo
  if (scraperKey) {
    try {
      const proxyUrl = `http://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=br`;
      const { data: html } = await axios.get(proxyUrl, { timeout: 60000 });
      const $ = cheerio.load(html);
      const imoveis = [];
      // VivaReal injeta dados em window.__INITIAL_STATE__
      $('script').each((_, el) => {
        const src = $(el).html() || '';
        if (src.includes('__INITIAL_STATE__')) {
          try {
            const match = src.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
            if (match) {
              const state = JSON.parse(match[1]);
              const listings = state?.results?.listings || [];
              listings.forEach(l => {
                const preco = parseInt(l?.listing?.pricingInfos?.[0]?.price) || 0;
                const link = l?.link?.href ? \`https://www.vivareal.com.br\${l.link.href}\` : '';
                const titulo = l?.listing?.title || \`Imovel VivaReal - \${bairro}\`;
                if (preco > 0 && link.length > 20) {
                  imoveis.push({ titulo, preco, bairro, tipo: 'residencial', portal: 'VivaReal', link });
                }
              });
            }
          } catch(pe) {}
        }
      });
      if (imoveis.length > 0) return imoveis;
    } catch (e) {
      console.log(\`   ⚠️  VivaReal ScraperAPI falhou para \${bairro}: \${e.message?.slice(0, 50)}\`);
    }
  }
  return [];
}

// ─── MERCADO LIVRE (API pública oficial, sem chave) ───────────────────────────
// Categoria MLB1574 = Imóveis, MLB200000 = Aluguel residencial SP
async function buscarMercadoLivre(bairro) {
  try {
    // Busca por categoria imóveis aluguel + cidade SP + bairro no título
    const url = `https://api.mercadolibre.com/sites/MLB/search?category=MLB1574&q=${encodeURIComponent(`aluguel ${bairro} sao paulo`)}&limit=48&offset=0`;
    const { data } = await axios.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 20000,
    });
    const results = data?.results || [];
    return results
      .filter(i => i.price && i.price > 0)
      .map(i => ({
        titulo: i.title || `Imovel - ${bairro}`,
        preco: parseInt(i.price) || 0,
        bairro,
        tipo: 'residencial',
        portal: 'MercadoLivre',
        link: i.permalink || i.id ? `https://imoveis.mercadolivre.com.br/MLB-${i.id}` : '',
      }))
      .filter(i => i.preco > 0 && i.link.length > 20);
  } catch (e) {
    console.log(`   ⚠️  MercadoLivre falhou para ${bairro}: ${e.message?.slice(0, 50)}`);
    return [];
  }
}

// ─── OLX (parse HTML — sem proxy, melhor esforço) ────────────────────────────
// ─── OLX via Apify (conta dedicada OLX) ──────────────────────────────────────
async function buscarOLXApify(bairro) {
  const token = process.env.APIFY_TOKEN_OLX;
  if (!token) return [];
  const slug = toSlug(bairro);
  const searchUrl = `https://www.olx.com.br/imoveis/aluguel/estado-sp/sao-paulo-e-regiao/${slug}`;
  const input = {
    startUrls: [{ url: searchUrl }],
    maxItems: 48,
    proxyConfiguration: { useApifyProxy: true },
  };
  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/daddyapi~olx-brazil-scraper/run-sync-get-dataset-items?token=${token}&timeout=90&memory=256`,
      input,
      { headers: { 'Content-Type': 'application/json' }, timeout: 100000 }
    );
    const items = runRes.data || [];
    if (!Array.isArray(items) || items.length === 0) return [];
    return items
      .filter(i => i.price && i.price > 0)
      .map(i => ({
        titulo: i.title || `Imovel OLX - ${bairro}`,
        preco: typeof i.price === 'string' ? parseInt(i.price.replace(/\D/g, '')) : parseInt(i.price) || 0,
        bairro,
        tipo: 'residencial',
        portal: 'OLX',
        link: i.url || i.link || '',
      }))
      .filter(i => i.preco > 0 && i.link.length > 20);
  } catch (e) {
    console.log(`   ⚠️  OLX Apify falhou para ${bairro}: ${e.message?.slice(0, 60)}`);
    return [];
  }
}

// ─── OLX via ScraperAPI (fallback grátis 1000 req/mês) ───────────────────────
async function buscarOLXScraperAPI(bairro) {
  const scraperKey = process.env.SCRAPERAPI_KEY;
  if (!scraperKey) return [];
  const slug = toSlug(bairro);
  const targetUrl = `https://www.olx.com.br/imoveis/aluguel/estado-sp/sao-paulo-e-regiao/${slug}?sf=1`;
  const proxyUrl = `http://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=br`;
  try {
    const { data: html } = await axios.get(proxyUrl, {
      headers: { 'Accept': 'text/html' },
      timeout: 60000,
    });
    const $ = cheerio.load(html);
    const imoveis = [];
    const nextData = $('script#__NEXT_DATA__').html();
    if (nextData) {
      const parsed = JSON.parse(nextData);
      const ads = parsed?.props?.pageProps?.ads
        || parsed?.props?.pageProps?.listingProps?.ads
        || [];
      ads.forEach(ad => {
        const preco = parseInt((ad.price || '').replace(/\D/g, '')) || 0;
        const link = ad.url || ad.linkUrl || '';
        const titulo = ad.title || `Imovel OLX - ${bairro}`;
        if (preco > 0 && link.length > 20) {
          imoveis.push({ titulo, preco, bairro, tipo: 'residencial', portal: 'OLX', link });
        }
      });
    }
    return imoveis;
  } catch (e) {
    console.log(`   ⚠️  OLX ScraperAPI falhou para ${bairro}: ${e.message?.slice(0, 50)}`);
    return [];
  }
}

// Orquestra OLX: Apify primeiro, ScraperAPI como fallback
async function buscarOLXHtml(bairro) {
  // Tenta Apify dedicado OLX
  if (process.env.APIFY_TOKEN_OLX) {
    const result = await buscarOLXApify(bairro);
    if (result.length > 0) return result;
  }
  // Fallback: ScraperAPI (1000 req/mês grátis)
  if (process.env.SCRAPERAPI_KEY) {
    return buscarOLXScraperAPI(bairro);
  }
  return [];
}

const BUSCAS = [
  // Bairros originais
  { bairro: 'Pinheiros',      region: 'pinheiros'      },
  { bairro: 'Vila Madalena',  region: 'vila-madalena'  },
  { bairro: 'Faria Lima',     region: 'faria-lima'     },
  { bairro: 'Moema',          region: 'moema'          },
  { bairro: 'Itaim Bibi',     region: 'itaim-bibi'     },
  // Novos bairros
  { bairro: 'Jardins',        region: 'jardins'        },
  { bairro: 'Vila Olimpia',   region: 'vila-olimpia'   },
  { bairro: 'Brooklin',       region: 'brooklin'       },
  { bairro: 'Perdizes',       region: 'perdizes'       },
  { bairro: 'Consolacao',     region: 'consolacao'     },
];

function toSlug(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// Busca ZAP direto — sem proxy, sem custo. Apify só como backup emergencial.
async function buscarZapDireto(bairro) {
  const slug = toSlug(bairro);
  // User-Agents rotativos para reduzir chance de bloqueio
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  ];
  const ua = UAS[Math.floor(Math.random() * UAS.length)];
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'x-domain': 'www.zapimoveis.com.br',
    'Origin': 'https://www.zapimoveis.com.br',
    'Referer': 'https://www.zapimoveis.com.br/',
  };
  const PAGE_SIZE = 48;
  const todos = [];

  const url = `https://glue-api.zapimoveis.com.br/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=${PAGE_SIZE}&from=0`;
  try {
    const { data } = await axios.get(url, { headers, timeout: 30000 });
    const listings = data?.search?.result?.listings || [];
    const imoveis = listings
      .filter(i => i?.listing?.pricingInfos?.[0]?.price)
      .map(i => ({
        titulo: i.listing.title || `Imovel - ${bairro}`,
        preco: parseInt(i.listing.pricingInfos[0].price) || 0,
        bairro, tipo: 'residencial', portal: 'ZAP',
        link: `https://www.zapimoveis.com.br${i.link?.href || ''}`,
      }))
      .filter(i => i.preco > 0 && i.link.length > 30);
    todos.push(...imoveis);
  } catch (e) {
    throw e; // propaga para o chamador decidir o fallback
  }
  return todos;
}

// Fallback via proxy pago (ScraperAPI/BrightData) — reserva, raramente usado
async function buscarZapViaProxy(bairro) {
  const slug = toSlug(bairro);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'x-domain': 'www.zapimoveis.com.br',
    'Origin': 'https://www.zapimoveis.com.br',
    'Referer': 'https://www.zapimoveis.com.br/',
  };
  const PAGE_SIZE = 48;
  const url = `https://glue-api.zapimoveis.com.br/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=${PAGE_SIZE}&from=0`;
  const { data } = await axiosProxy(url, headers, 45000);
  const listings = data?.search?.result?.listings || [];
  return listings
    .filter(i => i?.listing?.pricingInfos?.[0]?.price)
    .map(i => ({
      titulo: i.listing.title || `Imovel - ${bairro}`,
      preco: parseInt(i.listing.pricingInfos[0].price) || 0,
      bairro, tipo: 'residencial', portal: 'ZAP',
      link: `https://www.zapimoveis.com.br${i.link?.href || ''}`,
    }))
    .filter(i => i.preco > 0 && i.link.length > 30);
}

// VivaReal desativado (DNS descontinuado desde 2024)
async function buscarVivaReal(bairro) { return []; }

async function buscarOLX(bairro, region) {
  console.log(`\n🔍 Buscando imoveis: ${bairro}`);

  // Roda todas as fontes grátis em paralelo para máxima cobertura
  const [zapDireto, vivaReal, mercadoLivre, olxHtml] = await Promise.allSettled([
    buscarZapDireto(bairro),
    buscarVivaRealDireto(bairro),
    buscarMercadoLivre(bairro),
    buscarOLXHtml(bairro),
  ]);

  const todos = [
    ...(zapDireto.status === 'fulfilled' ? zapDireto.value : []),
    ...(vivaReal.status === 'fulfilled' ? vivaReal.value : []),
    ...(mercadoLivre.status === 'fulfilled' ? mercadoLivre.value : []),
    ...(olxHtml.status === 'fulfilled' ? olxHtml.value : []),
  ];

  // Se todas as fontes grátis falharam, tenta proxy como reserva
  if (todos.length === 0) {
    console.log(`   ⚠️  Fontes grátis sem resultado, tentando proxy...`);
    try {
      const imoveis = await buscarZapViaProxy(bairro);
      todos.push(...imoveis);
    } catch (e) {
      console.log(`   __ Proxy falhou: ${e.message?.slice(0, 50)}`);
    }
  }

  // Último recurso: Apify (caro — backup de emergência)
  if (todos.length === 0 && process.env.APIFY_TOKEN) {
    try {
      const apifyResult = await buscarViaApify(bairro);
      if (apifyResult && apifyResult.length > 0) todos.push(...apifyResult);
      console.log(`   ⚠️  Usando Apify (backup emergencial) para ${bairro}`);
    } catch (e) {
      console.log(`   __ Apify também falhou: ${e.message?.slice(0, 50)}`);
    }
  }

  // Deduplica por link
  const unicos = [...new Map(todos.map(i => [i.link, i])).values()];
  const porPortal = {};
  unicos.forEach(i => { porPortal[i.portal] = (porPortal[i.portal] || 0) + 1; });
  console.log(`   ✓ ${unicos.length} imoveis total:`, Object.entries(porPortal).map(([k,v]) => `${k}=${v}`).join(', '));
  return unicos;
}

async function salvarImoveis(imoveis) {
  if (imoveis.length === 0) return 0;
  const { data, error } = await supabase
    .from('imoveis')
    .upsert(imoveis, { onConflict: 'link', ignoreDuplicates: true })
    .select();
  if (error) { console.error('   _ Erro ao salvar:', error.message); return 0; }
  const novos = data ? data.length : 0;
  if (novos > 0) console.log(`   💾 ${novos} imoveis novos salvos!`);
  return novos;
}

async function verificarAlertas() {
  // Busca usuários ativos com alerta configurado nas colunas alerta_*
  const { data: usuarios } = await supabase
    .from('users')
    .select('id, whatsapp, alerta_bairros, alerta_tipos, alerta_preco_max, alerta_quartos_min, alerta_area_min, alerta_silencio_inicio, alerta_silencio_fim, alerta_freq_max, plano_validade')
    .eq('ativo', true)
    .not('whatsapp', 'is', null)
    .not('alerta_bairros', 'is', null);

  if (!usuarios || usuarios.length === 0) {
    console.log('   ℹ️  Nenhum usuário com alerta configurado.');
    return;
  }

  for (const usuario of usuarios) {
    // Checa validade do plano
    const validade = usuario.plano_validade ? new Date(usuario.plano_validade) : null;
    if (!validade || validade <= new Date()) continue;

    // Horário de silêncio
    if (usuario.alerta_silencio_inicio && usuario.alerta_silencio_fim) {
      const hora = new Date().getHours();
      const ini  = parseInt(usuario.alerta_silencio_inicio);
      const fim  = parseInt(usuario.alerta_silencio_fim);
      const emSilencio = ini > fim
        ? (hora >= ini || hora < fim)
        : (hora >= ini && hora < fim);
      if (emSilencio) continue;
    }

    const bairros    = usuario.alerta_bairros   || [];
    const precoMax   = usuario.alerta_preco_max  || 99999;
    const quartosMin = parseInt(usuario.alerta_quartos_min) || 0;
    const areaMin    = parseInt(usuario.alerta_area_min)    || 0;
    const freqMax    = usuario.alerta_freq_max === 'ilimitado' ? 9999 : parseInt(usuario.alerta_freq_max) || 9999;

    // Conta alertas enviados hoje (controle de frequência)
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const { count: alertasHoje } = await supabase
      .from('alertas')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', usuario.id)
      .gte('created_at', hoje.toISOString());
    if ((alertasHoje || 0) >= freqMax) continue;

    // Busca imóveis novos (últimos 65 min) que batem com os filtros do usuário
    for (const bairro of bairros) {
      const { data: matches } = await supabase
        .from('imoveis')
        .select('*')
        .ilike('bairro', `%${bairro}%`)
        .lte('preco', precoMax)
        .gte('encontrado_em', new Date(Date.now() - 65 * 60 * 1000).toISOString());

      if (!matches || matches.length === 0) continue;

      for (const imovel of matches) {
        // Filtros adicionais
        if (quartosMin > 0 && (imovel.quartos || 0) < quartosMin) continue;
        if (areaMin   > 0 && (imovel.area    || 0) < areaMin)    continue;

        // Evita reenvio
        const { data: jaEnviado } = await supabase
          .from('alertas')
          .select('id')
          .eq('user_id', usuario.id)
          .eq('imovel_id', imovel.id)
          .maybeSingle();
        if (jaEnviado) continue;

        // Registra e envia
        await supabase.from('alertas').insert({
          user_id:   usuario.id,
          imovel_id: imovel.id,
        });

        await enviarWhatsApp(usuario.whatsapp, imovel);
        console.log(`   🔔 Alerta: ${imovel.titulo} → ${usuario.whatsapp}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
}

async function rodarScraper() {
  console.log(`\n🚀 SaiuVaga - ${new Date().toLocaleString('pt-BR')}`);
  let total = 0;
  for (const b of BUSCAS) {
    const imoveis = await buscarOLX(b.bairro, b.region);
    total += await salvarImoveis(imoveis);
    await new Promise(r => setTimeout(r, 2000));
  }
  await verificarAlertas();
  console.log(`\n✅ Concluido! ${total} novos imoveis salvos.\n`);
}

cron.schedule('0 */4 * * *', rodarScraper); // 1x a cada 4h — preserva free tiers
rodarScraper();
