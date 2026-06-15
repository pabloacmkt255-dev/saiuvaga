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
// Necessário para proxies BrightData que usam certificado self-signed
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

// -- Robustez: pool de User-Agents (reduz padrão de detecção) ----
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];
function getRandomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

// -- Robustez: jitter (delay aleatório) para evitar bursts ------
function jitter(minMs = 800, maxMs = 4000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

// -- Robustez: circuit breaker por fonte -------------------------
// Após N falhas seguidas, "desliga" a fonte por algumas horas para
// não desperdiçar cota de proxy/Apify nem chamar repetidamente algo
// que está banido.
const CIRCUIT_THRESHOLD   = 3;                  // falhas seguidas até abrir o circuito
const CIRCUIT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h de cooldown
const circuitState = {};

function circuitAllows(source) {
  const s = circuitState[source];
  if (!s || !s.cooldownUntil) return true;
  if (Date.now() >= s.cooldownUntil) {
    s.cooldownUntil = 0;
    s.failCount = 0;
    return true;
  }
  return false;
}
function circuitFail(source) {
  const s = circuitState[source] || (circuitState[source] = { failCount: 0, cooldownUntil: 0 });
  s.failCount++;
  if (s.failCount >= CIRCUIT_THRESHOLD) {
    s.cooldownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.log(`   ⛔ Circuit breaker: ${source} em cooldown por 2h (${s.failCount} falhas seguidas)`);
  }
}
function circuitSuccess(source) {
  const s = circuitState[source];
  if (s) { s.failCount = 0; s.cooldownUntil = 0; }
}

// -- Robustez: estado global do scraper (para healthcheck) -------
const scraperHealth = {
  lastRunAt: null,
  lastRunTotal: null,
  consecutiveEmptyCycles: 0,
};

async function enviarWhatsApp(telefone, imovel = null, mensagemLivre = null) {
  const mensagem = mensagemLivre || (
    `🚨 *Nova vaga - ${imovel.bairro}!*\n\n` +
    `🏠 ${imovel.titulo}\n` +
    `💰 R$ ${(imovel.preco || 0).toLocaleString('pt-BR')}/mes\n` +
    `📍 ${imovel.bairro}, SP\n` +
    `🔗 ${imovel.link}\n\n` +
    `_Responda PARAR para cancelar alertas_`
  );

  let phone = telefone.replace(/\D/g, '');
  // Remove 55 duplicado: sempre normaliza removendo 55 inicial e readicionando
  phone = '55' + phone.replace(/^55/, '');

  // Valida número mínimo (55 + DDD 2 dígitos + número 8-9 dígitos = 12-13 dígitos)
  if (phone.length < 12) {
    console.error(`   _ WhatsApp inválido ignorado: "${telefone}" → "${phone}"`);
    return false;
  }

  const MAX_TENTATIVAS = 2;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      const res = await axios.post(
        `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
        { phone, message: mensagem },
        {
          headers: {
            'Content-Type': 'application/json',
            'Client-Token': ZAPI_CLIENT_TOKEN
          },
          timeout: 15000,
        }
      );
      console.log(`   📲 WhatsApp enviado para ${phone} | id: ${res.data?.zaapId || res.data?.messageId}`);
      return true;
    } catch (err) {
      const errData = err.response?.data;
      const detail = errData?.message || errData?.error || errData?.value || JSON.stringify(errData) || err.message;
      console.error(`   _ Erro Z-API (tentativa ${tentativa}/${MAX_TENTATIVAS}): ${detail} | phone: ${phone} | status: ${err.response?.status}`);
      if (tentativa < MAX_TENTATIVAS) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  return false;
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
// ─── Extrai intenção de busca via Groq ───────────────────────────────────────
async function extrairIntencaoBusca(text) {
  try {
    const resposta = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{
          role: 'user',
          content: `Analise a mensagem abaixo e extraia a intenção de busca de imóvel para aluguel em São Paulo.
Responda APENAS com um JSON válido, sem texto adicional:
{
  "ehBusca": true/false,
  "bairros": ["bairro1", "bairro2"],
  "precoMax": 0,
  "quartos": 0,
  "tipo": ""
}
Regras:
- ehBusca = true se a pessoa quer buscar/encontrar imóvel para alugar agora
- bairros: lista de bairros mencionados (vazio se não mencionou)
- precoMax: valor máximo em reais (0 se não mencionou)
- quartos: número mínimo de quartos (0 se não mencionou)
- tipo: "apartamento", "casa", "kitnet" ou "" se não especificou
- Se for só uma pergunta geral sobre o produto/preço/como funciona, ehBusca = false

Mensagem: "${text.replace(/"/g, '\'')}"`,
        }],
        max_tokens: 150,
        temperature: 0.1,
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` } }
    );
    const raw = resposta.data?.choices?.[0]?.message?.content || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return { ehBusca: false };
  }
}

// ─── Busca imóveis no banco conforme intenção ─────────────────────────────────
async function buscarImoveisParaUsuario(intencao) {
  try {
    let query = supabase
      .from('imoveis')
      .select('titulo, preco, bairro, tipo, portal, link, encontrado_em')
      .order('encontrado_em', { ascending: false })
      .limit(5);

    if (intencao.precoMax > 0) query = query.lte('preco', intencao.precoMax);
    if (intencao.tipo) query = query.ilike('tipo', `%${intencao.tipo}%`);

    // Se mencionou bairros, busca por qualquer um deles
    if (intencao.bairros && intencao.bairros.length > 0) {
      const filtros = intencao.bairros.map(b => `bairro.ilike.%${b}%`).join(',');
      query = query.or(filtros);
    }

    const { data } = await query;
    return data || [];
  } catch (e) {
    console.error('Erro busca imóveis:', e.message);
    return [];
  }
}

// ─── Formata lista de imóveis para WhatsApp ───────────────────────────────────
function formatarImoveisWpp(imoveis, intencao) {
  if (imoveis.length === 0) {
    const bairros = intencao.bairros?.join(', ') || 'São Paulo';
    return `🔍 Não encontrei imóveis disponíveis agora para ${bairros} com esses critérios.\n\nNossa base é atualizada a cada 4h. Configure seus alertas em saiuvaga.com.br/saiuvaga-alertas.html para ser avisado assim que surgir uma vaga! 🔔`;
  }

  let msg = `🏠 *Encontrei ${imoveis.length} imóvel(is) disponíveis:*\n\n`;
  imoveis.forEach((im, i) => {
    const preco = im.preco ? `R$${Number(im.preco).toLocaleString('pt-BR')}/mês` : 'Consulte';
    msg += `*${i + 1}. ${im.bairro || 'SP'}*\n`;
    msg += `${im.titulo || 'Imóvel disponível'}\n`;
    msg += `💰 ${preco} · ${im.portal}\n`;
    msg += `🔗 ${im.link}\n\n`;
  });
  msg += `_Quer receber novos imóveis assim que saírem? Configure seus alertas em saiuvaga.com.br/saiuvaga-alertas.html_`;
  return msg;
}

// ─── Processa mensagem recebida no WhatsApp ───────────────────────────────────
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

    // ── Comando PARAR — cancela alertas ──────────────────────────────────────
    if (text.trim().toUpperCase() === 'PARAR') {
      if (user) {
        await supabase.from('users').update({
          alerta_bairros: null,
          ativo: false,
        }).ilike('whatsapp', `%${numero}%`);
        await enviarWhatsApp(phone, null, '✅ Seus alertas foram cancelados. Para reativar, acesse saiuvaga.com.br');
      } else {
        await enviarWhatsApp(phone, null, 'Número não encontrado em nossa base. Acesse saiuvaga.com.br para cadastrar.');
      }
      return;
    }

    // ── Detecta se é busca de imóvel ──────────────────────────────────────────
    const intencao = await extrairIntencaoBusca(text);

    if (intencao.ehBusca) {
      // Usuário quer buscar imóvel agora — faz busca real no banco
      const imoveis = await buscarImoveisParaUsuario(intencao);
      const mensagem = formatarImoveisWpp(imoveis, intencao);
      await enviarWhatsApp(phone, null, mensagem);
      console.log(`   🔍 Busca via WPP: ${imoveis.length} resultado(s) → ${phone}`);
      return;
    }

    // ── Resposta geral via Groq ───────────────────────────────────────────────
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
- Configurar alertas: saiuvaga.com.br/saiuvaga-alertas.html

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
- Se o usuario quiser buscar imoveis, sugira que ele configure os alertas no link acima

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
// -- Salvar/buscar alerta do usuário (usa service key, passa RLS) -------------
app.post('/api/usuario/alerta', async (req, res) => {
  try {
    const { user_id, alerta_bairros, alerta_preco_max, alerta_quartos_min, alerta_area_min, alerta_tipos, alerta_freq_max, whatsapp } = req.body;
    if (!user_id) return res.status(400).json({ erro: 'user_id obrigatorio' });

    // Valida token — garante que só o próprio usuário altera seu alerta
    const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ erro: 'Autenticacao obrigatoria' });
    const { data: { user: sessionUser }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !sessionUser || sessionUser.id !== user_id) return res.status(403).json({ erro: 'Acesso negado' });

    // Monta payload — inclui whatsapp se fornecido
    const payload = {
      alerta_bairros:     alerta_bairros?.length ? alerta_bairros : null,
      alerta_preco_max:   alerta_preco_max   || null,
      alerta_quartos_min: alerta_quartos_min || 0,
      alerta_area_min:    alerta_area_min    || 0,
      alerta_tipos:       alerta_tipos       || [],
      alerta_freq_max:    alerta_freq_max    || 'ilimitado',
    };
    if (whatsapp) payload.whatsapp = whatsapp.replace(/\D/g, '');

    const { error } = await supabase.from('users').update(payload).eq('id', user_id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/usuario/alerta', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ erro: 'user_id obrigatorio' });

    const { data, error } = await supabase.from('users')
      .select('alerta_bairros, alerta_preco_max, alerta_quartos_min, alerta_area_min, alerta_tipos, alerta_freq_max')
      .eq('id', user_id).maybeSingle();

    if (error) throw error;
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

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

const ADMIN_SECRET = process.env.ADMIN_SECRET;
if (!ADMIN_SECRET) console.warn('⚠️  ADMIN_SECRET nao configurado — rotas /api/admin desativadas');

function verificarAdmin(req, res) {
  if (!ADMIN_SECRET) {
    res.status(503).json({ erro: 'Admin nao configurado' });
    return false;
  }
  const auth = req.headers['authorization'] || '';
  const senha = auth.replace('Bearer ', '').trim();
  if (senha !== ADMIN_SECRET) {
    res.status(401).json({ erro: 'Acesso negado' });
    return false;
  }
  return true;
}

app.get('/api/admin/health', (req, res) => {
  if (!verificarAdmin(req, res)) return;
  const envCheck = (name) => Boolean(process.env[name]);
  res.json({
    env: {
      SUPABASE_URL: envCheck('SUPABASE_URL'),
      SUPABASE_SERVICE_KEY: envCheck('SUPABASE_SERVICE_KEY'),
      MP_ACCESS_TOKEN: envCheck('MP_ACCESS_TOKEN'),
      GROQ_API_KEY: envCheck('GROQ_API_KEY'),
      ZAPI_INSTANCE: envCheck('ZAPI_INSTANCE'),
      ZAPI_TOKEN: envCheck('ZAPI_TOKEN'),
      APIFY_TOKEN_VIVAREAL: envCheck('APIFY_TOKEN_VIVAREAL'),
      APIFY_TOKEN_OLX: envCheck('APIFY_TOKEN_OLX'),
      APIFY_TOKEN_ZAP: envCheck('APIFY_TOKEN_ZAP'),
      APIFY_TOKEN_POOL: envCheck('APIFY_TOKEN_POOL'),
      RESIDENTIAL_PROXY_URL: envCheck('RESIDENTIAL_PROXY_URL'),
      SCRAPERAPI_KEY: envCheck('SCRAPERAPI_KEY'),
      SCRAPEDO_KEY: envCheck('SCRAPEDO_KEY'),
      BRIGHTDATA_KEY: envCheck('BRIGHTDATA_KEY'),
      BRIGHTDATA_UNLOCKER_KEY: envCheck('BRIGHTDATA_UNLOCKER_KEY'),
      BRIGHTDATA_UNLOCKER_ZONE: envCheck('BRIGHTDATA_UNLOCKER_ZONE'),
      BRIGHTDATA_BROWSER_WS: envCheck('BRIGHTDATA_BROWSER_WS'),
      ADMIN_WHATSAPP: envCheck('ADMIN_WHATSAPP'),
    },
    scraper: scraperHealth,
    circuitBreaker: circuitState,
  });
});

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

// ─── Pool de tokens Apify (cascata entre contas, evita limite mensal) ────────
function getApifyTokenPool() {
  const candidates = [
    process.env.APIFY_TOKEN_VIVAREAL,
    process.env.APIFY_TOKEN_OLX,
    process.env.APIFY_TOKEN_ZAP,
    process.env.APIFY_TOKEN,
    ...((process.env.APIFY_TOKEN_POOL || '').split(',').map(t => t.trim())),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

// Tenta rodar o actor cheerio-scraper, alternando entre todos os tokens
// disponíveis (cascata) se um deles estiver sem crédito/banido.
async function runApifyCheerio(input, primaryToken) {
  const tokens = [primaryToken, ...getApifyTokenPool()].filter(Boolean);
  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) throw new Error('Nenhum APIFY_TOKEN configurado');

  let lastError;
  for (const token of uniqueTokens) {
    try {
      const runRes = await axios.post(
        `https://api.apify.com/v2/acts/apify~cheerio-scraper/run-sync-get-dataset-items?token=${token}&timeout=90&memory=128`,
        input,
        { headers: { 'Content-Type': 'application/json' }, timeout: 100000 }
      );
      return runRes.data || [];
    } catch (e) {
      lastError = e;
      const msg = e.response?.data?.error?.type || e.message || '';
      console.log(`   __ Apify token ...${token.slice(-6)} falhou: ${String(msg).slice(0,50)}`);
    }
  }
  throw lastError || new Error('Todos os tokens Apify falharam');
}

// Busca imoveis via Apify actor fatihtahta/zap-imoveis-scraper
async function buscarViaApify(bairro) {
  const token = process.env.APIFY_TOKEN_ZAP || process.env.APIFY_TOKEN;
  if (!token && getApifyTokenPool().length === 0) return null;

  const slug = toSlug(bairro);
  // Usa cheerio-scraper (muito mais barato que zap-imoveis-scraper)
  // Tenta ZAP direto primeiro, depois VivaReal como fallback
  const targetUrl = `https://www.zapimoveis.com.br/aluguel/imoveis/sp+sao-paulo+${slug}/`;
  const input = {
    startUrls: [{ url: targetUrl }],
    maxCrawlingDepth: 0,
    maxResultsPerCrawl: 24,
    pageFunction: `async function pageFunction(context) {
      const { $ } = context;
      const items = [];
      const nextDataEl = $('script#__NEXT_DATA__');
      if (nextDataEl.length) {
        try {
          const parsed = JSON.parse(nextDataEl.html());
          const listings =
            parsed?.props?.pageProps?.initialProps?.listings ||
            parsed?.props?.pageProps?.listings ||
            parsed?.props?.pageProps?.search?.result?.listings || [];
          listings.forEach(l => {
            const preco = parseInt(l?.listing?.pricingInfos?.[0]?.price) || 0;
            const href = l?.link?.href || '';
            const link = href ? 'https://www.zapimoveis.com.br' + href : '';
            const titulo = l?.listing?.title || 'Imovel ZAP';
            const quartos = l?.listing?.bedrooms || null;
            const area = l?.listing?.usableAreas?.[0] || null;
            if (preco > 0 && link.length > 20) items.push({ titulo, preco, link, quartos, area });
          });
        } catch(e) {}
      }
      return items;
    }`,
  };

  try {
    const items = await runApifyCheerio(input, token);
    if (!Array.isArray(items) || items.length === 0) return [];

    // cheerio-scraper retorna items diretos já mapeados
    if (items[0]?.link) {
      return items
        .filter(i => i.preco > 0 && i.link?.length > 20)
        .map(i => ({ ...i, bairro, tipo: 'residencial', portal: 'ZAP' }));
    }

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
  const residentialProxyUrl = process.env.RESIDENTIAL_PROXY_URL;
  const scraperApiKey = process.env.SCRAPERAPI_KEY;
  const scrapeDoKey   = process.env.SCRAPEDO_KEY;
  const brightDataKey = process.env.BRIGHTDATA_KEY;

  // 0) Proxy residencial (mais resistente a bans de IP de datacenter)
  if (residentialProxyUrl) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyAgent = new HttpsProxyAgent(residentialProxyUrl);
      const res = await axios.get(url, { headers, timeout, httpAgent: proxyAgent, httpsAgent: proxyAgent, proxy: false });
      if (res.status >= 400) throw new Error(`status ${res.status}`);
      return res;
    } catch (e) {
      console.log(`   __ Proxy residencial falhou (${e.message?.slice(0,50)}), tentando ScraperAPI...`);
    }
  }

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
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyAgent = new HttpsProxyAgent(`http://brd-customer-hl_auto:${brightDataKey}@brd.superproxy.io:22225`);
      const res = await axios.get(url, { headers, timeout, httpAgent: proxyAgent, httpsAgent: proxyAgent, proxy: false });
      return res;
    } catch (e) {
      console.log(`   __ BrightData falhou (${e.message?.slice(0,40)}), tentando direto...`);
    }
  }

  return axios.get(url, { headers, timeout });
}

async function buscarVivaRealScraperAPI(bairro) {
  const scraperKey = process.env.SCRAPERAPI_KEY;
  if (!scraperKey) return [];
  const slug = toSlug(bairro);
  const targetUrl = `https://www.vivareal.com.br/aluguel/sp/sao-paulo/${slug}/`;
  const proxyUrl = `http://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=br`;
  try {
    const { data: html } = await axios.get(proxyUrl, {
      headers: { 'User-Agent': getRandomUA(), 'Accept': 'text/html', 'Accept-Language': 'pt-BR,pt;q=0.9' },
      timeout: 60000,
    });
    const $ = cheerio.load(html);
    const imoveis = [];
    // Estratégia 1: __NEXT_DATA__
    const nextData = $('script#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const parsed = JSON.parse(nextData);
        const listings =
          parsed?.props?.pageProps?.initialState?.results?.listings ||
          parsed?.props?.pageProps?.results?.listings || [];
        listings.forEach(l => {
          const preco = parseInt(l?.listing?.pricingInfos?.[0]?.price) || 0;
          const href = l?.link?.href || '';
          const link = href ? `https://www.vivareal.com.br${href}` : '';
          const titulo = l?.listing?.title || `Imovel VivaReal - ${bairro}`;
          if (preco > 0 && link.length > 20) {
            imoveis.push({ titulo, preco, bairro, tipo: 'residencial', portal: 'VivaReal', link });
          }
        });
      } catch(pe) {}
    }
    // Estratégia 2: __INITIAL_STATE__ inline
    if (imoveis.length === 0) {
      $('script').each((_, el) => {
        const src = $(el).html() || '';
        if (src.includes('__INITIAL_STATE__') && src.includes('listings')) {
          try {
            const match = src.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/);
            if (match) {
              const state = JSON.parse(match[1]);
              (state?.results?.listings || []).forEach(l => {
                const preco = parseInt(l?.listing?.pricingInfos?.[0]?.price) || 0;
                const link = l?.link?.href ? `https://www.vivareal.com.br${l.link.href}` : '';
                const titulo = l?.listing?.title || `Imovel VivaReal - ${bairro}`;
                if (preco > 0 && link.length > 20) {
                  imoveis.push({ titulo, preco, bairro, tipo: 'residencial', portal: 'VivaReal', link });
                }
              });
            }
          } catch(pe) {}
        }
      });
    }
    return imoveis;
  } catch (e) {
    console.log(`   ⚠️  VivaReal ScraperAPI falhou para ${bairro}: ${e.message?.slice(0, 50)}`);
    return [];
  }
}

async function buscarVivaRealDireto(bairro) {
  // VivaReal via Puppeteer é executado em conjunto com ZAP em buscarZapEVivaRealPuppeteer()
  // Este wrapper existe para manter compatibilidade com o orquestrador buscarOLX()
  // Na prática, o resultado vem de buscarZapEVivaRealPuppeteer chamado antes
  if (process.env.SCRAPERAPI_KEY) {
    const result = await buscarVivaRealScraperAPI(bairro);
    if (result.length > 0) return result;
  }
  return [];
}

// Busca ZAP + VivaReal em sequência num único browser (evita limite de sessões simultâneas)
async function buscarZapEVivaRealPuppeteer(bairro) {
  const wsEndpoint = process.env.BRIGHTDATA_BROWSER_WS;
  if (!wsEndpoint) return { zap: [], vivareal: [] };

  const slug = toSlug(bairro);
  const regiaoPrefix = BAIRRO_REGIAO.get(slug);

  const zapUrl = regiaoPrefix
    ? `https://www.zapimoveis.com.br/aluguel/imoveis/sp+sao-paulo+${regiaoPrefix}+${slug}/`
    : `https://www.zapimoveis.com.br/aluguel/imoveis/sp+sao-paulo+${slug}/`;

  const vrUrl = regiaoPrefix
    ? `https://www.vivareal.com.br/aluguel/sp/sao-paulo/${regiaoPrefix}/${slug}/`
    : `https://www.vivareal.com.br/aluguel/sp/sao-paulo/${slug}/`;

  let browser;
  try {
    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

    // ZAP
    let zapResult = [];
    try {
      const page = await browser.newPage();
      await page.goto(zapUrl, { waitUntil: 'networkidle2', timeout: 90000 });
      await new Promise(r => setTimeout(r, 5000));
      zapResult = await extrairImoveisDaPagina(page, 'ZAP', bairro, '/imovel/');
      await page.close();
      if (zapResult.length > 0) console.log(`   ✅ ZAP Puppeteer OK para ${bairro}: ${zapResult.length} imóveis`);
    } catch (e) {
      console.log(`   __ ZAP Puppeteer falhou para ${bairro}: ${e.message?.slice(0, 60)}`);
    }

    // VivaReal (mesma sessão)
    let vrResult = [];
    try {
      const page = await browser.newPage();
      await page.goto(vrUrl, { waitUntil: 'networkidle2', timeout: 90000 });
      await new Promise(r => setTimeout(r, 5000));
      vrResult = await extrairImoveisDaPagina(page, 'VivaReal', bairro, '/imovel/');
      await page.close();
      if (vrResult.length > 0) console.log(`   ✅ VivaReal Puppeteer OK para ${bairro}: ${vrResult.length} imóveis`);
    } catch (e) {
      console.log(`   __ VivaReal Puppeteer falhou para ${bairro}: ${e.message?.slice(0, 60)}`);
    }

    return { zap: zapResult, vivareal: vrResult };
  } catch (e) {
    console.log(`   __ Browser falhou para ${bairro}: ${e.message?.slice(0, 60)}`);
    return { zap: [], vivareal: [] };
  } finally {
    try { await browser?.close(); } catch {}
  }
}

// ─── MERCADO LIVRE — desativado (IP de servidor bloqueado com 403) ────────────
async function buscarMercadoLivre(bairro) { return []; }

async function buscarOLXScraperAPI(bairro) {
  const scraperKey = process.env.SCRAPERAPI_KEY;
  if (!scraperKey) return [];
  const slug = toSlug(bairro);
  const targetUrl = `https://www.olx.com.br/imoveis/aluguel/estado-sp/sao-paulo-e-regiao/${slug}`;
  const proxyUrl = `http://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=br`;
  try {
    const { data: html } = await axios.get(proxyUrl, {
      headers: { 'User-Agent': getRandomUA(), 'Accept': 'text/html' },
      timeout: 60000,
    });
    const $ = cheerio.load(html);
    const imoveis = [];
    const nextData = $('script#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const parsed = JSON.parse(nextData);
        const ads = parsed?.props?.pageProps?.ads
          || parsed?.props?.pageProps?.listingProps?.ads || [];
        ads.forEach(ad => {
          const preco = parseInt((ad.price || '').replace(/\D/g, '')) || 0;
          const link = ad.url || ad.linkUrl || '';
          const titulo = ad.title || `Imovel OLX - ${bairro}`;
          if (preco > 0 && link.length > 20) {
            imoveis.push({ titulo, preco, bairro, tipo: 'residencial', portal: 'OLX', link });
          }
        });
      } catch(pe) {
        console.log(`   ⚠️  OLX ScraperAPI parse falhou para ${bairro}: ${pe.message?.slice(0,40)}`);
      }
    }
    return imoveis;
  } catch (e) {
    console.log(`   ⚠️  OLX ScraperAPI falhou para ${bairro}: ${e.message?.slice(0, 50)}`);
    return [];
  }
}

// ─── ZAP + VivaReal via BrightData Scraping Browser (Puppeteer) ──────────────
// ZAP e VivaReal exigem JS real (SPA Next.js) + passar Cloudflare. O Web
// Unlocker "puro" não atende (filtra headers customizados, render:true não
// aguarda dados assíncronos). A "Scraping Browser" da BrightData (Puppeteer
// remoto via WebSocket) resolve ambos: executa JS completo e passa Cloudflare.
//
// URLs confirmadas (precisam do segmento "zona-oeste" para bairros da zona
// oeste de SP, como os 5 bairros monitorados):
//   ZAP:      https://www.zapimoveis.com.br/aluguel/imoveis/sp+sao-paulo+zona-oeste+{slug}/
//   VivaReal: https://www.vivareal.com.br/aluguel/sp/sao-paulo/zona-oeste/{slug}/

// Mapa bairro → região (slug usado nas URLs do ZAP/VivaReal). Bairros não
// listados são usados sem prefixo de região (alguns portais aceitam direto).
const BAIRRO_REGIAO = new Map([
  // Zona Oeste
  ['pinheiros', 'zona-oeste'],
  ['vila-madalena', 'zona-oeste'],
  ['perdizes', 'zona-oeste'],
  ['alto-de-pinheiros', 'zona-oeste'],
  ['butanta', 'zona-oeste'],
  ['vila-leopoldina', 'zona-oeste'],
  ['lapa', 'zona-oeste'],
  ['sumare', 'zona-oeste'],
  ['sumarezinho', 'zona-oeste'],
  ['jardins', 'zona-oeste'],
  ['jardim-paulista', 'zona-oeste'],
  ['vila-pompeia', 'zona-oeste'],
  ['vila-olimpia', 'zona-oeste'],
  ['faria-lima', 'zona-oeste'],
  // Zona Sul
  ['itaim-bibi', 'zona-sul'],
  ['moema', 'zona-sul'],
  ['jardim-america', 'zona-sul'],
  ['vila-mariana', 'zona-sul'],
  ['campo-belo', 'zona-sul'],
  ['brooklin', 'zona-sul'],
  ['saude', 'zona-sul'],
  ['paraiso', 'zona-sul'],
  ['aclimacao', 'zona-sul'],
  ['morumbi', 'zona-sul'],
  // Centro
  ['liberdade', 'centro'],
  ['bela-vista', 'centro'],
  ['consolacao', 'centro'],
  ['republica', 'centro'],
  ['bom-retiro', 'centro'],
  ['higienopolis', 'centro'],
  ['santa-cecilia', 'centro'],
  // Zona Norte
  ['santana', 'zona-norte'],
  // Zona Leste
  ['tatuape', 'zona-leste'],
  ['vila-prudente', 'zona-leste'],
  // Santo André — cidade do ABC, não tem região dentro do ZAP SP
  // (sem prefixo de região, scraper vai usar só o slug)
]);

async function getScrapingBrowser() {
  const wsEndpoint = process.env.BRIGHTDATA_BROWSER_WS;
  if (!wsEndpoint) return null;
  const puppeteer = require('puppeteer-core');
  return puppeteer.connect({ browserWSEndpoint: wsEndpoint });
}

// Extrai {preco, link, titulo} de uma página de listagens já carregada
async function extrairImoveisDaPagina(page, portal, bairro, linkMustInclude) {
  const raw = await page.evaluate((linkPart) => {
    const out = [];
    document.querySelectorAll(`a[href*="${linkPart}"]`).forEach(a => {
      const txt = a.innerText || '';
      const m = txt.match(/R\$\s*([\d.,]+)/);
      if (m) {
        const titleEl = a.querySelector('h2, h3');
        out.push({
          price: m[1],
          href: a.href.split('?')[0],
          title: titleEl ? titleEl.textContent.trim() : '',
        });
      }
    });
    return out;
  }, linkMustInclude);

  const seen = new Set();
  const imoveis = [];
  for (const item of raw) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    const preco = parseInt(String(item.price).replace(/\D/g, '')) || 0;
    if (preco > 0 && item.href.length > 30) {
      imoveis.push({
        titulo: item.title || `Imovel ${portal} - ${bairro}`,
        preco, bairro, tipo: 'residencial', portal, link: item.href,
      });
    }
  }
  return imoveis;
}

async function buscarZapPuppeteer(bairro) {
  const slug = toSlug(bairro);
  const regiaoPrefix = BAIRRO_REGIAO.get(slug);
  const regiao = regiaoPrefix ? `${regiaoPrefix}+${slug}` : slug;
  const targetUrl = `https://www.zapimoveis.com.br/aluguel/imoveis/sp+sao-paulo+${regiao}/`;

  let browser, page;
  try {
    browser = await getScrapingBrowser();
    if (!browser) return [];
    page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 5000));
    const imoveis = await extrairImoveisDaPagina(page, 'ZAP', bairro, '/imovel/');
    if (imoveis.length > 0) {
      console.log(`   ✅ ZAP Puppeteer OK para ${bairro}: ${imoveis.length} imóveis`);
    }
    return imoveis;
  } catch (e) {
    console.log(`   __ ZAP Puppeteer falhou para ${bairro}: ${e.message?.slice(0, 60)}`);
    return [];
  } finally {
    try { await page?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

async function buscarVivaRealPuppeteer(bairro) {
  const slug = toSlug(bairro);
  const regiaoPrefix = BAIRRO_REGIAO.get(slug);
  const regiao = regiaoPrefix ? `${regiaoPrefix}/${slug}` : slug;
  const targetUrl = `https://www.vivareal.com.br/aluguel/sp/sao-paulo/${regiao}/`;

  let browser, page;
  try {
    browser = await getScrapingBrowser();
    if (!browser) return [];
    page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 5000));
    const imoveis = await extrairImoveisDaPagina(page, 'VivaReal', bairro, '/imovel/');
    if (imoveis.length > 0) {
      console.log(`   ✅ VivaReal Puppeteer OK para ${bairro}: ${imoveis.length} imóveis`);
    }
    return imoveis;
  } catch (e) {
    console.log(`   __ VivaReal Puppeteer falhou para ${bairro}: ${e.message?.slice(0, 60)}`);
    return [];
  } finally {
    try { await page?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}


// Busca ZAP via BrightData Web Unlocker (API REST com headers via super-proxy)
async function buscarZapWebUnlocker(bairro) {
  const apiKey = process.env.BRIGHTDATA_UNLOCKER_KEY;
  const zone   = process.env.BRIGHTDATA_UNLOCKER_ZONE || 'web_unlocker1';
  if (!apiKey) return [];

  const slug = toSlug(bairro);
  const targetUrl = `https://glue-api.zapimoveis.com.br/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=12&from=0`;

  try {
    // Usa o super-proxy HTTP do BrightData com headers passados via x-unblock-*
    const { data } = await axios.get(targetUrl, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'application/json',
        'x-domain': 'www.zapimoveis.com.br',
        'Origin': 'https://www.zapimoveis.com.br',
        'Referer': 'https://www.zapimoveis.com.br/',
      },
      proxy: {
        protocol: 'http',
        host: 'brd.superproxy.io',
        port: 33335,
        auth: {
          username: `brd-customer-hl_f1fddda4-zone-${zone}`,
          password: 'hxvzw6m7zywj',
        },
      },
      timeout: 60000,
    });

    const listings = data?.search?.result?.listings || [];
    if (listings.length === 0) console.log(`   __ ZAP Web Unlocker: 0 listings para ${bairro}`);

    const imoveis = listings
      .filter(i => i?.listing?.pricingInfos?.[0]?.price)
      .map(i => ({
        titulo: i.listing.title || `Imovel ZAP - ${bairro}`,
        preco:  parseInt(i.listing.pricingInfos[0].price) || 0,
        bairro, tipo: 'residencial', portal: 'ZAP',
        link: `https://www.zapimoveis.com.br${i.link?.href || ''}`,
        quartos: i.listing.bedrooms?.[0] || 0,
        area:    parseInt(i.listing.usableAreas?.[0]) || 0,
      }))
      .filter(i => i.preco > 0 && i.link.length > 30);

    if (imoveis.length > 0) console.log(`   ✅ ZAP Web Unlocker OK para ${bairro}: ${imoveis.length} imóveis`);
    return imoveis;
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 100) : e.message?.slice(0, 100);
    console.log(`   __ ZAP Web Unlocker falhou para ${bairro}: ${detail}`);
    return [];
  }
}

// Busca VivaReal via BrightData Web Unlocker (API REST com proxy nativo)
async function buscarVivaRealWebUnlocker(bairro) {
  const apiKey = process.env.BRIGHTDATA_UNLOCKER_KEY;
  const zone   = process.env.BRIGHTDATA_UNLOCKER_ZONE || 'web_unlocker1';
  if (!apiKey) return [];

  const slug = toSlug(bairro);
  const targetUrl = `https://glue-api.vivareal.com/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=12&from=0`;

  try {
    const { data } = await axios.get(targetUrl, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'application/json',
        'x-domain': 'www.vivareal.com.br',
        'Origin': 'https://www.vivareal.com.br',
        'Referer': 'https://www.vivareal.com.br/',
      },
      proxy: {
        protocol: 'http',
        host: 'brd.superproxy.io',
        port: 33335,
        auth: {
          username: `brd-customer-hl_f1fddda4-zone-${zone}`,
          password: 'hxvzw6m7zywj',
        },
      },
      timeout: 60000,
    });

    const listings = data?.search?.result?.listings || [];
    if (listings.length === 0) console.log(`   __ VivaReal Web Unlocker: 0 listings para ${bairro}`);

    const imoveis = listings
      .filter(i => i?.listing?.pricingInfos?.[0]?.price)
      .map(i => ({
        titulo: i.listing.title || `Imovel VivaReal - ${bairro}`,
        preco:  parseInt(i.listing.pricingInfos[0].price) || 0,
        bairro, tipo: 'residencial', portal: 'VivaReal',
        link: `https://www.vivareal.com.br${i.link?.href || ''}`,
        quartos: i.listing.bedrooms?.[0] || 0,
        area:    parseInt(i.listing.usableAreas?.[0]) || 0,
      }))
      .filter(i => i.preco > 0 && i.link.length > 30);

    if (imoveis.length > 0) console.log(`   ✅ VivaReal Web Unlocker OK para ${bairro}: ${imoveis.length} imóveis`);
    return imoveis;
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 100) : e.message?.slice(0, 100);
    console.log(`   __ VivaReal Web Unlocker falhou para ${bairro}: ${detail}`);
    return [];
  }
}

// Busca OLX via BrightData Web Unlocker (passa por Cloudflare/anti-bot)
async function buscarOLXWebUnlocker(bairro) {
  const apiKey = process.env.BRIGHTDATA_UNLOCKER_KEY;
  const zone   = process.env.BRIGHTDATA_UNLOCKER_ZONE || 'web_unlocker1';
  if (!apiKey) return [];

  const slug = toSlug(bairro);
  const targetUrl = `https://www.olx.com.br/imoveis/aluguel/estado-sp/sao-paulo-e-regiao/${slug}`;

  try {
    const { data: html } = await axios.post(
      'https://api.brightdata.com/request',
      { zone, url: targetUrl, format: 'raw' },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    const $ = cheerio.load(String(html));
    const imoveis = [];

    // 1) Tenta __NEXT_DATA__ (estrutura preferida, igual ScraperAPI)
    const nextData = $('script#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const parsed = JSON.parse(nextData);
        const ads = parsed?.props?.pageProps?.ads
          || parsed?.props?.pageProps?.listingProps?.ads || [];
        ads.forEach(ad => {
          const preco = parseInt((ad.price || '').replace(/\D/g, '')) || 0;
          const link = ad.url || ad.linkUrl || '';
          const titulo = ad.title || `Imovel OLX - ${bairro}`;
          if (preco > 0 && link.length > 20) {
            imoveis.push({ titulo, preco, bairro, tipo: 'residencial', portal: 'OLX', link });
          }
        });
      } catch (pe) {
        console.log(`   ⚠️  OLX Web Unlocker parse (__NEXT_DATA__) falhou: ${pe.message?.slice(0,40)}`);
      }
    }

    // 2) Fallback: parse direto do DOM renderizado (cards .olx-adcard__*)
    if (imoveis.length === 0) {
      $('[class*="olx-adcard__price"]').each((_, el) => {
        const precoTxt = $(el).text();
        const preco = parseInt(precoTxt.replace(/\D/g, '')) || 0;
        if (preco <= 0) return;
        const card = $(el).closest('a, [class*="olx-adcard"]');
        let link = card.is('a') ? card.attr('href') : card.find('a').first().attr('href');
        if (link && !link.startsWith('http')) link = `https://www.olx.com.br${link}`;
        const titulo = card.find('h2, h3').first().text().trim() || `Imovel OLX - ${bairro}`;
        if (link && link.length > 20) {
          imoveis.push({ titulo, preco, bairro, tipo: 'residencial', portal: 'OLX', link });
        }
      });
    }

    return imoveis.filter(i => i.preco > 0 && i.link?.length > 20);
  } catch (e) {
    console.log(`   ⚠️  OLX Web Unlocker falhou para ${bairro}: ${e.message?.slice(0, 50)}`);
    return [];
  }
}

// Orquestra OLX: Web Unlocker primeiro (passa Cloudflare), depois Apify, depois ScraperAPI
async function buscarOLXHtml(bairro) {
  if (process.env.BRIGHTDATA_UNLOCKER_KEY) {
    const result = await buscarOLXWebUnlocker(bairro);
    if (result.length > 0) return result;
  }
  // Apify removido: bloqueado em todas as contas (cascata travava ~6-7min)
  if (process.env.SCRAPERAPI_KEY) {
    return buscarOLXScraperAPI(bairro);
  }
  return [];
}

// Bairros fixos — apenas quando não há alertas configurados para o bairro
// O scraper prioriza bairros com alertas ativos (ver rodarScraper)
const BUSCAS = [
  { bairro: 'Pinheiros',      region: 'pinheiros'      },
  { bairro: 'Vila Madalena',  region: 'vila-madalena'  },
  { bairro: 'Moema',          region: 'moema'          },
  { bairro: 'Itaim Bibi',     region: 'itaim-bibi'     },
  { bairro: 'Perdizes',       region: 'perdizes'        },
  { bairro: 'Brooklin',       region: 'brooklin'        },
  { bairro: 'Vila Mariana',   region: 'vila-mariana'   },
  { bairro: 'Jardins',        region: 'jardins'         },
  { bairro: 'Higienópolis',   region: 'higienopolis'   },
  { bairro: 'Vila Olímpia',   region: 'vila-olimpia'   },
  { bairro: 'Faria Lima',     region: 'faria-lima'     },
  { bairro: 'Bela Vista',     region: 'bela-vista'     },
  { bairro: 'Consolação',     region: 'consolacao'     },
  { bairro: 'Campo Belo',     region: 'campo-belo'     },
  { bairro: 'Jardim Paulista', region: 'jardim-paulista' },
];

function toSlug(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// Busca ZAP direto — tenta VivaReal glue-api primeiro (mais permissiva com IPs de servidor),
// depois ZAP glue-api. Apify só como backup emergencial.
async function buscarZapDireto(bairro) {
  const slug = toSlug(bairro);
  const PAGE_SIZE = 48;

  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ];
  const ua = UAS[Math.floor(Math.random() * UAS.length)];

  // ── Tentativa 1: VivaReal glue-api (mesma infra do ZAP, IP de servidor aceito com mais frequência)
  try {
    const headersVR = {
      'User-Agent': ua,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'x-domain': 'www.vivareal.com.br',
      'Origin': 'https://www.vivareal.com.br',
      'Referer': 'https://www.vivareal.com.br/',
    };
    const urlVR = `https://glue-api.vivareal.com/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=${PAGE_SIZE}&from=0`;
    const { data } = await axios.get(urlVR, { headers: headersVR, timeout: 30000 });
    const listings = data?.search?.result?.listings || [];
    const imoveis = listings
      .filter(i => i?.listing?.pricingInfos?.[0]?.price)
      .map(i => ({
        titulo: i.listing.title || `Imovel - ${bairro}`,
        preco: parseInt(i.listing.pricingInfos[0].price) || 0,
        bairro, tipo: 'residencial', portal: 'VivaReal',
        link: `https://www.vivareal.com.br${i.link?.href || ''}`,
      }))
      .filter(i => i.preco > 0 && i.link.length > 30);
    if (imoveis.length > 0) {
      console.log(`   ✅ VivaReal glue-api OK para ${bairro}: ${imoveis.length} imóveis`);
      return imoveis;
    }
  } catch (e) {
    console.log(`   __ VivaReal glue-api falhou para ${bairro}: ${e.message?.slice(0, 50)}`);
  }

  // ── Tentativa 2: ZAP glue-api com headers atualizados (Chrome 125)
  try {
    const headersZAP = {
      'User-Agent': ua,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'x-domain': 'www.zapimoveis.com.br',
      'Origin': 'https://www.zapimoveis.com.br',
      'Referer': 'https://www.zapimoveis.com.br/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
    };
    const urlZAP = `https://glue-api.zapimoveis.com.br/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=${PAGE_SIZE}&from=0`;
    const { data } = await axios.get(urlZAP, { headers: headersZAP, timeout: 30000 });
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
    if (imoveis.length > 0) {
      console.log(`   ✅ ZAP glue-api OK para ${bairro}: ${imoveis.length} imóveis`);
      return imoveis;
    }
  } catch (e) {
    // não propaga ainda — deixa cair para a Tentativa 3 (Web Unlocker)
  }

  // ── Tentativa 3: já tratado via buscarZapEVivaRealPuppeteer em buscarOLX()
  // Não abre sessão Puppeteer aqui pra evitar sessões duplicadas/custo extra

  throw new Error('Nenhum resultado nas glue-apis (ZAP)');
}

// Fallback via proxy pago — tenta VivaReal glue-api primeiro, depois ZAP
async function buscarZapViaProxy(bairro) {
  const slug = toSlug(bairro);
  const PAGE_SIZE = 48;

  // Tenta VivaReal via proxy
  try {
    const headersVR = {
      'User-Agent': getRandomUA(),
      'Accept': 'application/json',
      'x-domain': 'www.vivareal.com.br',
      'Origin': 'https://www.vivareal.com.br',
      'Referer': 'https://www.vivareal.com.br/',
    };
    const urlVR = `https://glue-api.vivareal.com/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=${PAGE_SIZE}&from=0`;
    const { data } = await axiosProxy(urlVR, headersVR, 45000);
    const listings = data?.search?.result?.listings || [];
    const imoveis = listings
      .filter(i => i?.listing?.pricingInfos?.[0]?.price)
      .map(i => ({
        titulo: i.listing.title || `Imovel - ${bairro}`,
        preco: parseInt(i.listing.pricingInfos[0].price) || 0,
        bairro, tipo: 'residencial', portal: 'VivaReal',
        link: `https://www.vivareal.com.br${i.link?.href || ''}`,
      }))
      .filter(i => i.preco > 0 && i.link.length > 30);
    if (imoveis.length > 0) return imoveis;
  } catch (e) {
    console.log(`   __ Proxy VivaReal glue-api falhou: ${e.message?.slice(0, 50)}`);
  }

  // Tenta ZAP via proxy
  const headersZAP = {
    'User-Agent': getRandomUA(),
    'Accept': 'application/json',
    'x-domain': 'www.zapimoveis.com.br',
    'Origin': 'https://www.zapimoveis.com.br',
    'Referer': 'https://www.zapimoveis.com.br/',
  };
  const urlZAP = `https://glue-api.zapimoveis.com.br/v2/listings?businessType=RENTAL&categoryPage=RESULT&citySlug=sao-paulo&stateSlug=sp&neighborhoodSlug=${slug}&size=${PAGE_SIZE}&from=0`;
  const { data } = await axiosProxy(urlZAP, headersZAP, 45000);
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


async function buscarOLX(bairro, region) {
  console.log(`\n🔍 Buscando imoveis: ${bairro}`);

  // ZAP + VivaReal via Web Unlocker (glue-api JSON — mais estável que Puppeteer)
  // OLX também via Web Unlocker — todas as 3 fontes em paralelo
  const runSource = async (name, fn) => {
    if (!circuitAllows(name)) {
      console.log(`   ⛔ ${name} em cooldown (circuit breaker), pulando...`);
      return [];
    }
    await jitter();
    try {
      const result = await fn(bairro);
      if (result.length > 0) circuitSuccess(name); else circuitFail(name);
      return result;
    } catch (e) {
      circuitFail(name);
      return [];
    }
  };

  const [zapResult, vivaRealResult, olxResult] = await Promise.allSettled([
    runSource('zapWebUnlocker', buscarZapWebUnlocker),
    runSource('vivaRealWebUnlocker', buscarVivaRealWebUnlocker),
    runSource('olxHtml', buscarOLXHtml),
  ]);

  const todos = [
    ...(zapResult.status === 'fulfilled' ? zapResult.value : []),
    ...(vivaRealResult.status === 'fulfilled' ? vivaRealResult.value : []),
    ...(olxResult.status === 'fulfilled' ? olxResult.value : []),
  ];

  // Fallback: glue-api direto (sem proxy) se Web Unlocker não retornou ZAP/VivaReal
  if (zapResult.value?.length === 0 || vivaRealResult.value?.length === 0) {
    const [zapDireto, vivaReal] = await Promise.allSettled([
      zapResult.value?.length === 0 ? runSource('zapDireto', buscarZapDireto) : Promise.resolve([]),
      vivaRealResult.value?.length === 0 ? runSource('vivaReal', buscarVivaRealDireto) : Promise.resolve([]),
    ]);
    if (zapDireto.status === 'fulfilled') todos.push(...zapDireto.value);
    if (vivaReal.status === 'fulfilled') todos.push(...vivaReal.value);
  }

  // Apify ZAP dedicado — fallback quando tudo bloqueia
  let apifyZapCount = 0;
  if (todos.length === 0 && circuitAllows('apifyZap')
      && (process.env.APIFY_TOKEN_ZAP || process.env.APIFY_TOKEN || getApifyTokenPool().length > 0)) {
    try {
      await jitter();
      const apifyResult = await buscarViaApify(bairro);
      if (apifyResult === null) {
        circuitFail('apifyZap');
      } else {
        circuitSuccess('apifyZap');
        if (apifyResult.length > 0) {
          todos.push(...apifyResult);
          apifyZapCount = apifyResult.length;
          console.log(`   ✅ Apify ZAP OK para ${bairro}: ${apifyResult.length} imóveis`);
        }
      }
    } catch (e) {
      circuitFail('apifyZap');
      console.log(`   __ Apify ZAP falhou: ${e.message?.slice(0, 50)}`);
    }
  }

  // Proxy como último recurso
  if (todos.length === 0 && circuitAllows('proxyFinal')) {
    console.log(`   ⚠️  Tentando proxy como último recurso...`);
    try {
      await jitter();
      const imoveis = await buscarZapViaProxy(bairro);
      circuitSuccess('proxyFinal');
      todos.push(...imoveis);
    } catch (e) {
      circuitFail('proxyFinal');
      console.log(`   __ Proxy falhou: ${e.message?.slice(0, 50)}`);
    }
  }


  // Diagnóstico por fonte (ZAP inclui Apify se foi usado)
  const zapCount = (zapResult.status === 'fulfilled' ? zapResult.value?.length : 0) || 0;
  const vrCount  = (vivaRealResult.status === 'fulfilled' ? vivaRealResult.value?.length : 0) || 0;
  const olxCount = (olxResult.status === 'fulfilled' ? olxResult.value?.length : 0) || 0;
  console.log(`   📊 Fontes brutas: ZAP=${zapCount} VivaReal=${vrCount} OLX=${olxCount}`);

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
    .neq('whatsapp', '')
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
      const hora = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours(); // BRT = UTC-3
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
        .gte('encontrado_em', new Date(Date.now() - 300 * 60 * 1000).toISOString()); // 5h — cobre ciclo de 4h com folga

      if (!matches || matches.length === 0) continue;

      for (const imovel of matches) {
        // Filtros adicionais
        if (quartosMin > 0 && (imovel.quartos || 0) < quartosMin) continue;
        // Só filtra área se o imóvel tem área informada (area=0 significa sem informação)
        if (areaMin > 0 && imovel.area > 0 && imovel.area < areaMin) continue;
        const tipos = usuario.alerta_tipos || [];
        if (tipos.length > 0 && imovel.tipo && !tipos.includes(imovel.tipo)) continue;

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

  // Prioridade 1: bairros com alertas ativos (evita buscar bairros sem usuários)
  const { data: usuarios } = await supabase
    .from('users')
    .select('alerta_bairros')
    .eq('ativo', true)
    .not('alerta_bairros', 'is', null);

  const bairrosComAlerta = new Set();
  (usuarios || []).forEach(u => (u.alerta_bairros || []).forEach(b => bairrosComAlerta.add(b)));

  let bairrosParaBuscar;
  if (bairrosComAlerta.size > 0) {
    // Busca apenas bairros que têm alertas configurados
    bairrosParaBuscar = [...bairrosComAlerta].map(b => ({ bairro: b, region: toSlug(b) }));
    console.log(`   📋 Bairros com alertas: ${[...bairrosComAlerta].join(', ')}`);
  } else {
    // Sem alertas — usa lista fixa mínima para popular o banco
    bairrosParaBuscar = BUSCAS;
    console.log(`   📋 Sem alertas — usando bairros padrão`);
  }

  let totalEncontrados = 0;
  for (const b of bairrosParaBuscar) {
    const imoveis = await buscarOLX(b.bairro, b.region);
    totalEncontrados += imoveis.length;
    total += await salvarImoveis(imoveis);
    await new Promise(r => setTimeout(r, 2000));
  }
  await verificarAlertas();

  // -- Robustez: alerta automático em caso de ciclos vazios seguidos --
  scraperHealth.lastRunAt = new Date().toISOString();
  scraperHealth.lastRunTotal = totalEncontrados;
  if (totalEncontrados === 0) {
    scraperHealth.consecutiveEmptyCycles++;
  } else {
    scraperHealth.consecutiveEmptyCycles = 0;
  }

  const EMPTY_CYCLES_ALERT_THRESHOLD = 2; // ~8h sem nenhum imóvel encontrado
  if (scraperHealth.consecutiveEmptyCycles === EMPTY_CYCLES_ALERT_THRESHOLD && process.env.ADMIN_WHATSAPP) {
    try {
      await enviarWhatsApp(
        process.env.ADMIN_WHATSAPP,
        null,
        `⚠️ SaiuVaga: ${EMPTY_CYCLES_ALERT_THRESHOLD} ciclos seguidos sem encontrar nenhum imóvel (0 resultados em todas as fontes). Verifique os logs do Railway.`
      );
      console.log('   🔔 Alerta de falha enviado ao admin via WhatsApp.');
    } catch (e) {
      console.log(`   __ Falha ao enviar alerta admin: ${e.message?.slice(0, 50)}`);
    }
  }

  console.log(`\n✅ Concluido! ${total} novos imoveis salvos.\n`);
}

cron.schedule('0 */4 * * *', rodarScraper); // 1x a cada 4h — preserva free tiers
rodarScraper();
