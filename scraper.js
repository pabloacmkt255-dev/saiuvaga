// scraper.js — SaiuVaga (Z-API WhatsApp + Supabase + Mercado Pago)
require('dotenv').config();
const crypto = require('crypto');
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

// ── Z-API WhatsApp ───────────────────────────────────────────
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN    = process.env.ZAPI_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'saiuvaga_webhook_2024';

async function enviarWhatsApp(telefone, imovel = null, mensagemLivre = null) {
  const mensagem = mensagemLivre || (
    `🚨 *Nova vaga — ${imovel.bairro}!*\n\n` +
    `🏠 ${imovel.titulo}\n` +
    `💰 R$ ${imovel.preco.toLocaleString('pt-BR')}/mês\n` +
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
          'Client-Token': ZAPI_TOKEN
        }
      }
    );
    console.log(`   📲 WhatsApp enviado para ${phone} | id: ${res.data?.zaapId || res.data?.messageId}`);
    return true;
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    console.error(`   ✗ Erro Z-API: ${detail}`);
    return false;
  }
}

// ── Servidor Express ────────────────────────────────────────
const app = express();

// ── CORS ────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Guarda o raw body para validação do webhook do MP
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

// ── Rota de saúde ───────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'SaiuVaga online ✅',
  whatsapp: 'Z-API ativa',
  zapi_instance: ZAPI_INSTANCE ? '✅ configurado' : '❌ faltando'
}));

// ── Webhook Z-API — receber mensagens ────────────────────────
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

// ── Webhook GET (compatibilidade) ───────────────────────────
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

// ── Função de processar mensagem (chatbot Groq) ──────────────
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

// ── Ativar trial de 7 dias ──────────────────────────────────
app.post('/api/trial/ativar', async (req, res) => {
  try {
    const { user_id, email } = req.body;
    if (!user_id && !email) return res.status(400).json({ erro: 'user_id ou email obrigatório' });

    // Valida token de sessão Supabase — rejeita chamadas sem autenticação válida
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ erro: 'Autenticação obrigatória' });

    const { data: { user: sessionUser }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !sessionUser) return res.status(401).json({ erro: 'Token inválido ou expirado' });

    // Garante que o token pertence ao mesmo usuário da requisição
    if (user_id && sessionUser.id !== user_id) return res.status(403).json({ erro: 'Acesso negado' });
    if (email && sessionUser.email !== email) return res.status(403).json({ erro: 'Acesso negado' });

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
    res.json({ ok: true, mensagem: 'Trial de 7 dias ativado!', validade: validade.toISOString(), dias: 7 });

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
    if (!email || !nome || !cpf) return res.status(400).json({ erro: 'email, nome e cpf são obrigatórios' });

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
      valor, plano,
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
    if (!email || !nome || !cpf || !cep) return res.status(400).json({ erro: 'email, nome, cpf e cep são obrigatórios' });

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
      valor, plano,
    });

  } catch (err) {
    console.error('❌ Erro Boleto:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Gerar Cartão ────────────────────────────────────────────
app.post('/api/pagamento/cartao', async (req, res) => {
  try {
    const { email, nome, user_id, plano = 'mensal' } = req.body;
    if (!email || !nome) return res.status(400).json({ erro: 'email e nome são obrigatórios' });

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
      valor, plano,
    });

  } catch (err) {
    console.error('❌ Erro Cartão:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Webhook Mercado Pago ────────────────────────────────────
app.post('/api/webhook/mp', async (req, res) => {
  // ── Validação de assinatura Mercado Pago ─────────────────
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
          console.warn('⚠️ Webhook MP: assinatura inválida — requisição ignorada');
          return res.sendStatus(401);
        }
      }
    }
  } catch (sigErr) {
    console.error('❌ Erro validação assinatura MP:', sigErr.message);
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
    if (!email) return;

    const { data: user } = await supabase
      .from('users')
      .select('id, whatsapp, nome')
      .eq('email', email)
      .maybeSingle();

    if (!user) { console.log(`   ⚠️  Usuário não encontrado para ${email}`); return; }

    const diasPlano = pag.transaction_amount >= 35 ? 90 : 30;
    const validade = new Date();
    validade.setDate(validade.getDate() + diasPlano);

    await supabase.from('users').update({
      ativo: true,
      plano_validade: validade.toISOString(),
      ultimo_pagamento: new Date().toISOString(),
      mp_payment_id: String(pag.id),
    }).eq('id', user.id);

    console.log(`   ✅ Usuário ${email} ativado por ${diasPlano} dias`);

    if (user.whatsapp) {
      await enviarWhatsApp(
        user.whatsapp, null,
        `✅ *Pagamento confirmado!*\n\n` +
        `Olá ${user.nome || ''}! Seu acesso ao SaiuVaga foi ativado.\n` +
        `📅 Válido por ${diasPlano} dias.\n\n` +
        `Você receberá alertas de imóveis assim que houver novidades! 🏠`
      );
    }
  } catch (err) {
    console.error('❌ Erro webhook MP:', err.message);
  }
});

// ── Rotas legadas ───────────────────────────────────────────
app.get('/api/whatsapp/webhook', (req, res) => res.json({ ok: true, status: 'SaiuVaga Z-API ativa ✅' }));
app.post('/api/whatsapp/webhook', (req, res) => res.sendStatus(200));

// ── Admin API (dashboard) ────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// SCRAPER — Apify (principal) + ScraperAPI (fallback)
// ─────────────────────────────────────────────────────────────

// Busca imóveis via Apify actor fatihtahta/zap-imoveis-scraper
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
        const titulo = i.content?.title || `Imóvel - ${bairro}`;
        const link = i.source_context?.url || 'https://www.zapimoveis.com.br/';
        const bairroDado = i.location?.neighborhood || bairro;
        return { titulo, preco, bairro: bairroDado, tipo: 'residencial', portal: 'ZAP', link };
      })
      .filter(i => i.preco > 0 && i.link.length > 20);
  } catch (e) {
    console.log(`   ↩️ Apify falhou para ${bairro}: ${e.message?.slice(0, 60)}`);
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
      console.log(`   ↩️ ScraperAPI falhou (${e.message.slice(0,50)}), tentando Scrape.do...`);
    }
  }

  if (scrapeDoKey) {
    try {
      const proxyUrl = `https://api.scrape.do?token=${scrapeDoKey}&url=${encodeURIComponent(url)}&geoCode=br`;
      const res = await axios.get(proxyUrl, { headers, timeout });
      if (res.status >= 400) throw new Error(`status ${res.status}`);
      return res;
    } catch (e) {
      console.log(`   ↩️ Scrape.do falhou (${e.message.slice(0,50)}), tentando BrightData...`);
    }
  }

  if (brightDataKey) {
    try {
      const { HttpProxyAgent } = require('http-proxy-agent');
      const proxyAgent = new HttpProxyAgent(`http://brd-customer-hl_auto:${brightDataKey}@brd.superproxy.io:22225`);
      const res = await axios.get(url, { headers, timeout, httpAgent: proxyAgent, httpsAgent: proxyAgent });
      return res;
    } catch (e) {
      console.log(`   ↩️ BrightData falhou (${e.message.slice(0,40)}), tentando direto...`);
    }
  }

  return axios.get(url, { headers, timeout });
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
  { bairro: 'Vila Olímpia',   region: 'vila-olimpia'   },
  { bairro: 'Brooklin',       region: 'brooklin'       },
  { bairro: 'Perdizes',       region: 'perdizes'       },
  { bairro: 'Consolação',     region: 'consolacao'     },
];

function toSlug(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

async function buscarZap(bairro) {
  const slug = toSlug(bairro);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'x-domain': 'www.zapimoveis.com.br',
    'Origin': 'https://www.zapimoveis.com.br',
    'Referer': 'https://www.zapimoveis.com.br/',
  };
  const PAGE_SIZE = 48;
  const PAGES = 1; // 1 página × 48 = até 48 imóveis por bairro (economia de créditos ScraperAPI)
  const todos = [];

  for (let page = 0; page < PAGES; page++) {
    const from = page * PAGE_SIZE;
    const url = `https://glue-api.zapimoveis.com.br/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=${PAGE_SIZE}&from=${from}`;
    try {
      const { data } = await axiosProxy(url, headers, 45000);
      const listings = data?.search?.result?.listings || [];
      if (listings.length === 0) break; // sem mais páginas
      const imoveis = listings
        .filter(i => i?.listing?.pricingInfos?.[0]?.price)
        .map(i => ({
          titulo: i.listing.title || `Imóvel - ${bairro}`,
          preco: parseInt(i.listing.pricingInfos[0].price) || 0,
          bairro, tipo: 'residencial', portal: 'ZAP',
          link: `https://www.zapimoveis.com.br${i.link?.href || ''}`,
        }))
        .filter(i => i.preco > 0 && i.link.length > 30);
      todos.push(...imoveis);
      if (listings.length < PAGE_SIZE) break; // última página
      await new Promise(r => setTimeout(r, 1000)); // delay entre páginas
    } catch (e) {
      console.log(`   ⚠️ ZAP página ${page + 1}: ${e.message?.slice(0, 50)}`);
      break;
    }
  }
  return todos;
}

// VivaReal descontinuou glue-api.vivareal.com.br (DNS inexistente desde 2024).
// OLX Group unificou ZAP + VivaReal na mesma infraestrutura.
// Volume compensado com paginação do ZAP (3 páginas × 48) + 5 bairros novos.
async function buscarVivaReal(bairro) {
  return []; // desativado — DNS descontinuado
}

async function buscarOLX(bairro, region) {
  console.log(`\n🔍 Buscando imóveis: ${bairro}`);

  // Tenta Apify primeiro (actor dedicado ZAP)
  if (process.env.APIFY_TOKEN) {
    const apifyResult = await buscarViaApify(bairro);
    if (apifyResult !== null) {
      const unicos = [...new Map(apifyResult.map(i => [i.link, i])).values()];
      console.log(`   ✓ ${unicos.length} imóveis via Apify`);
      return unicos;
    }
    console.log(`   ↩️ Apify falhou, tentando ZAP direto...`);
  }

  // Fallback: ZAP via ScraperAPI
  try {
    const imoveis = await buscarZap(bairro);
    const unicos = [...new Map(imoveis.map(i => [i.link, i])).values()];
    console.log(`   ✓ ${unicos.length} imóveis via ZAP/ScraperAPI`);
    return unicos;
  } catch (e) {
    console.log(`   ⚠️ ZAP: ${e.message?.slice(0, 60)}`);
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
      .gte('encontrado_em', new Date(Date.now() - 20 * 60 * 1000).toISOString());

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

cron.schedule('*/20 * * * *', rodarScraper);
rodarScraper();
