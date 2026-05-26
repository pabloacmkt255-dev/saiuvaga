// server.js — SaiuVaga Backend (Pagamentos + API)
require('dotenv').config();
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

// ── Helper: parse body ──────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Helper: resposta JSON ───────────────────────────────────
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

// ── Helper: chamada Mercado Pago ────────────────────────────
async function mpPost(path, body) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.mercadopago.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Idempotency-Key': Date.now().toString(),
      },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Rotas ───────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = req.url;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    json(res, 200, {});
    return;
  }

  // ── POST /api/pagamento/pix ─────────────────────────────
  if (url === '/api/pagamento/pix' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const { plano, valor, email, nome } = body;

      const payment = await mpPost('/v1/payments', {
        transaction_amount: valor || 19,
        description: `SaiuVaga — Plano ${plano || 'Morador'}`,
        payment_method_id: 'pix',
        payer: {
          email: email || 'cliente@saiuvaga.com.br',
          first_name: nome || 'Cliente',
        },
      });

      if (payment.id) {
        json(res, 200, {
          id: payment.id,
          status: payment.status,
          qr_code: payment.point_of_interaction?.transaction_data?.qr_code,
          qr_code_base64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
        });
      } else {
        json(res, 400, { error: 'Erro ao gerar Pix', detail: payment });
      }
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/pagamento/cartao ──────────────────────────
  if (url === '/api/pagamento/cartao' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const { token, issuer_id, payment_method_id, installments, payer, plano, valor } = body;

      const payment = await mpPost('/v1/payments', {
        transaction_amount: valor || 19,
        token,
        description: `SaiuVaga — Plano ${plano || 'Morador'}`,
        installments: installments || 1,
        payment_method_id,
        issuer_id,
        payer: {
          email: payer?.email,
          identification: payer?.identification,
        },
      });

      if (payment.status === 'approved') {
        // Salva assinatura no banco
        await supabase.from('users').upsert(
          { email: payer?.email, plano: plano || 'morador' },
          { onConflict: 'email' }
        );
        json(res, 200, { status: 'approved', id: payment.id });
      } else {
        json(res, 200, { status: payment.status, detail: payment.status_detail });
      }
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/pagamento/boleto ──────────────────────────
  if (url === '/api/pagamento/boleto' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const { plano, valor, email, nome, cpf } = body;

      const payment = await mpPost('/v1/payments', {
        transaction_amount: valor || 19,
        description: `SaiuVaga — Plano ${plano || 'Morador'}`,
        payment_method_id: 'bolbradesco',
        payer: {
          email: email || 'cliente@saiuvaga.com.br',
          first_name: nome?.split(' ')[0] || 'Cliente',
          last_name: nome?.split(' ').slice(1).join(' ') || 'SaiuVaga',
          identification: { type: 'CPF', number: cpf || '00000000000' },
          address: { zip_code: '01310100', street_name: 'Av. Paulista', street_number: '1', neighborhood: 'Bela Vista', city: 'São Paulo', federal_unit: 'SP' },
        },
      });

      if (payment.id) {
        json(res, 200, {
          id: payment.id,
          status: payment.status,
          boleto_url: payment.transaction_details?.external_resource_url,
          barcode: payment.barcode?.content,
        });
      } else {
        json(res, 400, { error: 'Erro ao gerar boleto', detail: payment });
      }
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/webhook/mp ────────────────────────────────
  // Mercado Pago chama essa rota quando um pagamento é confirmado
  if (url.startsWith('/api/webhook/mp') && method === 'POST') {
    try {
      const body = await parseBody(req);
      console.log('📩 Webhook MP:', JSON.stringify(body));

      if (body.type === 'payment') {
        const paymentId = body.data?.id;
        console.log(`✅ Pagamento confirmado: ${paymentId}`);
        // Aqui você pode ativar o plano do usuário no banco
      }

      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /health ─────────────────────────────────────────
  if (url === '/health') {
    json(res, 200, { status: 'ok', time: new Date().toISOString() });
    return;
  }

  json(res, 404, { error: 'Rota não encontrada' });
}

// ── Inicia servidor ─────────────────────────────────────────
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\n🚀 SaiuVaga Server rodando na porta ${PORT}`);
  console.log(`   Rotas: /api/pagamento/pix | /api/pagamento/cartao | /api/pagamento/boleto`);
  console.log(`   Webhook MP: /api/webhook/mp\n`);
});
