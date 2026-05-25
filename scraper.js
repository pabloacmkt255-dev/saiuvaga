// scraper.js — SaiuVaga (Puppeteer + seletor corrigido)
require('dotenv').config();
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUSCAS = [
  { bairro: 'pinheiros',     tipo: 'residencial' },
  { bairro: 'vila-madalena', tipo: 'residencial' },
  { bairro: 'faria-lima',    tipo: 'comercial'   },
];

async function buscarOLX(browser, bairro, tipo) {
  console.log(`\n🔍 Buscando: ${bairro}`);
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.goto(`https://www.olx.com.br/imoveis/aluguel/estado-sp?q=${bairro}`, {
      waitUntil: 'networkidle2', timeout: 30000
    });

    const imoveis = await page.evaluate((bairroParam, tipoParam) => {
      const resultados = [];

      // Pega todos os links de anúncios
      const links = document.querySelectorAll('a[href*="olx.com.br/d/"]');

      links.forEach(link => {
        // Título vem do h2 ou h3 dentro do card
        const titulo = link.querySelector('h2, h3')?.textContent?.trim();
        if (!titulo) return;

        // Preço: busca elemento com R$ no texto
        let preco = 0;
        const allText = link.querySelectorAll('*');
        allText.forEach(el => {
          if (el.children.length === 0 && el.textContent.includes('R$')) {
            const num = parseInt(el.textContent.replace(/\D/g, ''));
            if (num > 200 && num < 50000) preco = num;
          }
        });

        const href = link.href?.split('?')[0] || '';
        if (titulo && href && preco > 0) {
          resultados.push({
            titulo,
            preco,
            bairro: bairroParam,
            tipo: tipoParam,
            portal: 'OLX',
            link: href,
          });
        }
      });

      return resultados;
    }, bairro, tipo);

    // Remove duplicatas por link
    const unicos = imoveis.filter((v, i, a) => a.findIndex(t => t.link === v.link) === i);
    console.log(`   ✓ ${unicos.length} imóveis encontrados`);
    await page.close();
    return unicos;

  } catch (err) {
    console.error(`   ✗ Erro: ${err.message}`);
    await page.close();
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
  if (novos > 0) console.log(`   💾 ${novos} imóveis novos salvos no banco!`);
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
        user_id: filtro.user_id,
        filtro_id: filtro.id,
        imovel_id: imovel.id,
      });
      console.log(`   🔔 Alerta gerado: ${imovel.titulo}`);
    }
  }
}

async function rodarScraper() {
  console.log(`\n🚀 SaiuVaga — ${new Date().toLocaleString('pt-BR')}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let totalNovos = 0;

  for (const busca of BUSCAS) {
    const imoveis = await buscarOLX(browser, busca.bairro, busca.tipo);
    const novos = await salvarImoveis(imoveis);
    totalNovos += novos;
    await new Promise(r => setTimeout(r, 3000));
  }

  await browser.close();
  await verificarAlertas();
  console.log(`\n✅ Concluído! ${totalNovos} imóveis novos salvos.\n`);
}

cron.schedule('*/5 * * * *', rodarScraper);
rodarScraper();
