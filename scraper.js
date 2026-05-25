// scraper.js — SaiuVaga (via Apify)
require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUSCAS = [
  { bairro: 'Pinheiros',     cidade: 'São Paulo', tipo: 'residencial' },
  { bairro: 'Vila Madalena', cidade: 'São Paulo', tipo: 'residencial' },
  { bairro: 'Faria Lima',    cidade: 'São Paulo', tipo: 'comercial'   },
];

async function buscarApify(bairro, cidade, tipo) {
  console.log(`\n🔍 Buscando: ${bairro}`);

  if (!process.env.APIFY_TOKEN) {
    console.log('   ⚠️  APIFY_TOKEN não configurado — usando dados de teste');
    return dadosTeste(bairro, tipo);
  }

  try {
    // Inicia o scraper de OLX no Apify
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

// Dados de teste para validar o banco enquanto Apify não está configurado
function dadosTeste(bairro, tipo) {
  return [
    {
      titulo: `Apartamento 2 quartos — ${bairro}`,
      preco: 1800,
      bairro,
      tipo,
      portal: 'OLX',
      link: `https://www.olx.com.br/teste-${bairro.toLowerCase().replace(/ /g,'-')}-${Date.now()}`,
    },
    {
      titulo: `Quitinete — ${bairro}`,
      preco: 1200,
      bairro,
      tipo,
      portal: 'OLX',
      link: `https://www.olx.com.br/teste2-${bairro.toLowerCase().replace(/ /g,'-')}-${Date.now()}`,
    }
  ];
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
  const { data: filtros } = await supabase.from('filtros').select('*').eq('ativo', true);
  if (!filtros || filtros.length === 0) return;
  for (const filtro of filtros) {
    const { data: matches } = await supabase
      .from('imoveis').select('*')
      .ilike('bairro', `%${filtro.bairro}%`)
      .lte('preco', filtro.preco_max)
      .gte('encontrado_em', new Date(Date.now() - 10 * 60 * 1000).toISOString());
    if (!matches || matches.length === 0) continue;
    for (const imovel of matches) {
      const { data: jaEnviado } = await supabase.from('alertas').select('id')
        .eq('user_id', filtro.user_id).eq('imovel_id', imovel.id).maybeSingle();
      if (jaEnviado) continue;
      await supabase.from('alertas').insert({
        user_id: filtro.user_id, filtro_id: filtro.id, imovel_id: imovel.id,
      });
      console.log(`   🔔 Alerta: ${imovel.titulo}`);
    }
  }
}

async function rodarScraper() {
  console.log(`\n🚀 SaiuVaga — ${new Date().toLocaleString('pt-BR')}`);
  let total = 0;
  for (const b of BUSCAS) {
    const imoveis = await buscarApify(b.bairro, b.cidade, b.tipo);
    total += await salvarImoveis(imoveis);
    await new Promise(r => setTimeout(r, 2000));
  }
  await verificarAlertas();
  console.log(`\n✅ Concluído! ${total} novos imóveis salvos.\n`);
}

cron.schedule('*/5 * * * *', rodarScraper);
rodarScraper();
