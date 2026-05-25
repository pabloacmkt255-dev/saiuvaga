// scraper.js — SaiuVaga (Apify + Supabase + Z-API WhatsApp)
require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUSCAS = [
  { bairro: 'Pinheiros',     tipo: 'residencial' },
  { bairro: 'Vila Madalena', tipo: 'residencial' },
  { bairro: 'Faria Lima',    tipo: 'comercial'   },
];

// ── Busca imóveis via Apify ─────────────────────────────────
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

// ── Salva imóveis novos no banco ────────────────────────────
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

// ── Envia alerta via Z-API WhatsApp ─────────────────────────
async function enviarWhatsApp(telefone, imovel) {
  if (!process.env.ZAPI_INSTANCE || !process.env.ZAPI_TOKEN) {
    console.log('   ⚠️  Z-API não configurado');
    return false;
  }

  const mensagem =
    `🚨 *Nova vaga — ${imovel.bairro}!*\n\n` +
    `🏠 ${imovel.titulo}\n` +
    `💰 R$ ${imovel.preco.toLocaleString('pt-BR')}/mês\n` +
    `📍 ${imovel.bairro}, SP\n` +
    `🔗 ${imovel.link}\n\n` +
    `_Responda PARAR para cancelar alertas_`;

  try {
    await axios.post(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`,
      {
        phone: telefone,
        message: mensagem,
      },
      { timeout: 10000 }
    );
    console.log(`   📲 WhatsApp enviado para ${telefone}`);
    return true;
  } catch (err) {
    console.error(`   ✗ Erro Z-API: ${err.message}`);
    return false;
  }
}

// ── Verifica filtros e dispara alertas ──────────────────────
async function verificarAlertas() {
  // Busca filtros ativos com dados do usuário (whatsapp)
  const { data: filtros } = await supabase
    .from('filtros')
    .select('*, users(whatsapp)')
    .eq('ativo', true);

  if (!filtros || filtros.length === 0) return;

  for (const filtro of filtros) {
    const whatsapp = filtro.users?.whatsapp;
    if (!whatsapp) continue;

    // Imóveis novos dos últimos 10 min que batem com o filtro
    const { data: matches } = await supabase
      .from('imoveis')
      .select('*')
      .ilike('bairro', `%${filtro.bairro}%`)
      .lte('preco', filtro.preco_max)
      .gte('encontrado_em', new Date(Date.now() - 10 * 60 * 1000).toISOString());

    if (!matches || matches.length === 0) continue;

    for (const imovel of matches) {
      // Checa se alerta já foi enviado
      const { data: jaEnviado } = await supabase
        .from('alertas')
        .select('id')
        .eq('user_id', filtro.user_id)
        .eq('imovel_id', imovel.id)
        .maybeSingle();

      if (jaEnviado) continue;

      // Salva o alerta no banco
      await supabase.from('alertas').insert({
        user_id: filtro.user_id,
        filtro_id: filtro.id,
        imovel_id: imovel.id,
      });

      // Envia WhatsApp
      await enviarWhatsApp(whatsapp, imovel);
      console.log(`   🔔 Alerta: ${imovel.titulo} → ${whatsapp}`);

      // Pausa de 1s entre mensagens para não sobrecarregar
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── Roda o scraper completo ─────────────────────────────────
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

// Roda a cada 5 minutos
cron.schedule('*/5 * * * *', rodarScraper);

// Roda imediatamente ao iniciar
rodarScraper();
