export const LIVE_PAGE_COUNT_PER_LANGUAGE = 50;

const LIVE_PAGE_TOPICS = Object.freeze([
  pages('Artificial intelligence', 'Artificial_intelligence', 'Artificiell_intelligens', 'Inteligencia_artificial', 'Kunstmatige_intelligentie'),
  pages('Computer', 'Computer', 'Dator', 'Computadora', 'Computer'),
  pages('Internet', 'Internet', 'Internet', 'Internet', 'Internet'),
  pages('World Wide Web', 'World_Wide_Web', 'Webben', 'World_Wide_Web', 'Wereldwijd_web'),
  pages('Software', 'Software', 'Programvara', 'Software', 'Software'),
  pages('Science', 'Science', 'Vetenskap', 'Ciencia', 'Wetenschap'),
  pages('Mathematics', 'Mathematics', 'Matematik', 'Matem%C3%A1ticas', 'Wiskunde'),
  pages('Physics', 'Physics', 'Fysik', 'F%C3%ADsica', 'Natuurkunde'),
  pages('Chemistry', 'Chemistry', 'Kemi', 'Qu%C3%ADmica', 'Scheikunde'),
  pages('Biology', 'Biology', 'Biologi', 'Biolog%C3%ADa', 'Biologie'),
  pages('Medicine', 'Medicine', 'Medicin_(vetenskap)', 'Medicina', 'Geneeskunde'),
  pages('Psychology', 'Psychology', 'Psykologi', 'Psicolog%C3%ADa', 'Psychologie'),
  pages('Education', 'Education', 'Utbildning', 'Educaci%C3%B3n', 'Onderwijs'),
  pages('History', 'History', 'Historia', 'Historia', 'Geschiedenis'),
  pages('Geography', 'Geography', 'Geografi', 'Geograf%C3%ADa', 'Aardrijkskunde'),
  pages('Economy', 'Economy', 'Ekonomi', 'Econom%C3%ADa', 'Economie_(systeem)'),
  pages('Democracy', 'Democracy', 'Demokrati', 'Democracia', 'Democratie'),
  pages('Human rights', 'Human_rights', 'M%C3%A4nskliga_r%C3%A4ttigheter', 'Derechos_humanos', 'Rechten_van_de_mens'),
  pages('Global warming', 'Global_warming', 'Global_uppv%C3%A4rmning', 'Calentamiento_global', 'Opwarming_van_de_Aarde'),
  pages('Renewable energy', 'Renewable_energy', 'F%C3%B6rnybar_energi', 'Energ%C3%ADa_renovable', 'Duurzame_energie'),
  pages('Solar energy', 'Solar_energy', 'Solenergi', 'Energ%C3%ADa_solar', 'Zonne-energie'),
  pages('Wind power', 'Wind_power', 'Vindkraft', 'Energ%C3%ADa_e%C3%B3lica', 'Windenergie'),
  pages('Electric vehicle', 'Electric_vehicle', 'Elfordon', 'Veh%C3%ADculo_el%C3%A9ctrico', 'Elektrisch_voertuig'),
  pages('Public transport', 'Public_transport', 'Kollektivtrafik', 'Transporte_p%C3%BAblico', 'Openbaar_vervoer'),
  pages('Railway', 'Rail_transport', 'J%C3%A4rnv%C3%A4gstransport', 'Transporte_ferroviario', 'Treinvervoer'),
  pages('Agriculture', 'Agriculture', 'Jordbruk', 'Agricultura', 'Landbouw'),
  pages('Food', 'Food', 'Mat', 'Alimento', 'Voedsel'),
  pages('Music', 'Music', 'Musik', 'M%C3%BAsica', 'Muziek'),
  pages('Literature', 'Literature', 'Litteratur', 'Literatura', 'Literatuur'),
  pages('Film', 'Film', 'Film', 'Pel%C3%ADcula', 'Film_(cinematografie)'),
  pages('Photography', 'Photography', 'Fotografi', 'Fotograf%C3%ADa', 'Fotografie'),
  pages('Architecture', 'Architecture', 'Arkitektur', 'Arquitectura', 'Architectuur'),
  pages('Engineering', 'Engineering', 'Ingenj%C3%B6rsvetenskap', 'Ingenier%C3%ADa', 'Engineering'),
  pages('Spaceflight', 'Spaceflight', 'Rymdfart', 'Vuelo_espacial', 'Ruimtevaart'),
  pages('Moon', 'Moon', 'M%C3%A5nen', 'Luna', 'Maan'),
  pages('Mars', 'Mars', 'Mars_(planet)', 'Marte_(planeta)', 'Mars_(planeet)'),
  pages('Earth', 'Earth', 'Jorden', 'Tierra', 'Aarde_(planeet)'),
  pages('Ocean', 'Ocean', 'Ocean', 'Oc%C3%A9ano', 'Oceaan'),
  pages('Mountain', 'Mountain', 'Berg', 'Monta%C3%B1a', 'Berg_(landvorm)'),
  pages('Forest', 'Forest', 'Skog', 'Bosque', 'Bos_(vegetatie)'),
  pages('River', 'River', 'Flod', 'R%C3%ADo', 'Rivier'),
  pages('City', 'City', 'Stad', 'Ciudad', 'Stad'),
  pages('Museum', 'Museum', 'Museum', 'Museo', 'Museum'),
  pages('Library', 'Library', 'Bibliotek', 'Biblioteca', 'Bibliotheek_(algemeen)'),
  pages('University', 'University', 'Universitet', 'Universidad', 'Universiteit'),
  pages('Newspaper', 'Newspaper', 'Tidning', 'Peri%C3%B3dico', 'Krant'),
  pages('Radio', 'Radio', 'Radio', 'Radiocomunicaci%C3%B3n', 'Radio'),
  pages('Television', 'Television', 'Television', 'Televisi%C3%B3n', 'Televisie'),
  pages('Coffee', 'Coffee', 'Kaffe', 'Caf%C3%A9', 'Koffie_(drank)'),
  pages('Association football', 'Association_football', 'Fotboll', 'F%C3%BAtbol', 'Voetbal'),
]);

function pages(name, en, sv, es, nl) {
  return { name, paths: { en, sv, es, nl } };
}

function languagePages(code, label) {
  return {
    code,
    label,
    pages: LIVE_PAGE_TOPICS.map((topic) => {
      const translated = getLaunchLanguagePathOverrides(topic.name, topic.paths.en);
      const explicitPath = topic.paths[code] || translated[code] || '';
      const path = explicitPath || topic.paths.en;
      return {
        name: topic.name,
        languageCode: code,
        languageLabel: label,
        englishPath: topic.paths.en,
        path,
        usesFallbackPath: !explicitPath && code !== 'en',
        url: `https://${code}.wikipedia.org/wiki/${path}`,
      };
    }),
  };
}

const resolvedLanguageLinkCache = new Map();
const resolvedLanguageGroupCache = new Map();

export async function resolveLivePageUrl(page, { fetchImpl = globalThis.fetch } = {}) {
  if (!page?.usesFallbackPath) return page.url;

  const cacheKey = `${page.languageCode}:${page.englishPath}`;
  if (resolvedLanguageLinkCache.has(cacheKey)) return resolvedLanguageLinkCache.get(cacheKey);

  const resolved = await resolveLivePageLanguageLinks([page], page.languageCode, page.languageLabel, { fetchImpl });
  const url = resolved.get(page.englishPath) || page.url;
  resolvedLanguageLinkCache.set(cacheKey, url);
  return url;
}

export async function resolveLiveLanguageGroupPages(group, { fetchImpl = globalThis.fetch } = {}) {
  const fallbackPages = group.pages.filter((page) => page.usesFallbackPath);
  if (!fallbackPages.length) return group;
  const cacheKey = `${group.code}:${group.pages.map((page) => page.englishPath).join('|')}`;
  if (resolvedLanguageGroupCache.has(cacheKey)) return resolvedLanguageGroupCache.get(cacheKey);

  const resolved = await resolveLivePageLanguageLinks(fallbackPages, group.code, group.label, { fetchImpl });
  const nextGroup = {
    ...group,
    pages: group.pages.map((page) => {
      if (!page.usesFallbackPath) return page;
      const resolvedUrl = resolved.get(page.englishPath) || page.url;
      resolvedLanguageLinkCache.set(`${page.languageCode}:${page.englishPath}`, resolvedUrl);
      return {
        ...page,
        resolvedUrl,
      };
    }),
  };
  resolvedLanguageGroupCache.set(cacheKey, nextGroup);
  return nextGroup;
}

async function resolveLivePageLanguageLinks(pages, languageCode, languageLabel, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Live page language-link resolution requires fetch.');
  const titles = pages.map((page) => pathToTitle(page.englishPath));
  const params = new URLSearchParams({
    action: 'query',
    titles: titles.join('|'),
    redirects: '1',
    prop: 'langlinks',
    lllang: languageCode,
    lllimit: 'max',
    format: 'json',
    origin: '*',
  });
  const response = await fetchWithRetry(fetchImpl, `https://en.wikipedia.org/w/api.php?${params}`);
  if (!response?.ok) {
    throw new Error(`Could not resolve ${languageLabel} Wikipedia URLs for live launch pages.`);
  }
  const data = await response.json();
  const lookup = createTitleLookup(pages, data?.query);
  const resolved = new Map();
  for (const pageData of Object.values(data?.query?.pages || {})) {
    const page = lookup.get(normalizeTitleKey(pageData?.title));
    const translatedTitle = pageData?.langlinks?.[0]?.['*'];
    if (!page || !translatedTitle) continue;
    resolved.set(page.englishPath, `https://${languageCode}.wikipedia.org/wiki/${titleToPath(translatedTitle)}`);
  }
  return resolved;
}

async function fetchWithRetry(fetchImpl, url) {
  let lastResponse = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': 'PageNarrator live launch tests (local development)',
      },
    });
    lastResponse = response;
    if (response?.status !== 429) return response;
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000 * (attempt + 1));
    });
  }
  return lastResponse;
}

function createTitleLookup(pages, query) {
  const lookup = new Map();
  for (const page of pages) {
    lookup.set(normalizeTitleKey(pathToTitle(page.englishPath)), page);
  }
  for (const normalized of query?.normalized || []) {
    const page = lookup.get(normalizeTitleKey(normalized.from));
    if (page) lookup.set(normalizeTitleKey(normalized.to), page);
  }
  for (const redirect of query?.redirects || []) {
    const page = lookup.get(normalizeTitleKey(redirect.from));
    if (page) lookup.set(normalizeTitleKey(redirect.to), page);
  }
  return lookup;
}

function pathToTitle(path) {
  return decodeURIComponent(String(path || '').replace(/_/g, ' '));
}

function normalizeTitleKey(title) {
  return pathToTitle(title).replace(/\s+/g, ' ').trim().toLowerCase();
}

function titleToPath(title) {
  return encodeURIComponent(String(title || '').trim().replace(/\s+/g, '_'))
    .replace(/%2F/gi, '/');
}

function getLaunchLanguagePathOverrides(name, englishPath) {
  return TRANSLATED_TOPIC_PATHS[name] || {
    zh: englishPath,
    it: englishPath,
    pt: englishPath,
  };
}

const TRANSLATED_TOPIC_PATHS = Object.freeze({
  'Artificial intelligence': { zh: '%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD', it: 'Intelligenza_artificiale', pt: 'Intelig%C3%AAncia_artificial' },
  Computer: { zh: '%E8%AE%A1%E7%AE%97%E6%9C%BA', it: 'Computer', pt: 'Computador' },
  Internet: { zh: '%E4%BA%92%E8%81%94%E7%BD%91', it: 'Internet', pt: 'Internet' },
  'World Wide Web': { zh: '%E4%B8%87%E7%BB%B4%E7%BD%91', it: 'World_Wide_Web', pt: 'World_Wide_Web' },
  Software: { zh: '%E8%BD%AF%E4%BB%B6', it: 'Software', pt: 'Software' },
  Science: { zh: '%E7%A7%91%E5%AD%A6', it: 'Scienza', pt: 'Ci%C3%AAncia' },
  Mathematics: { zh: '%E6%95%B0%E5%AD%A6', it: 'Matematica', pt: 'Matem%C3%A1tica' },
  Physics: { zh: '%E7%89%A9%E7%90%86%E5%AD%A6', it: 'Fisica', pt: 'F%C3%ADsica' },
  Chemistry: { zh: '%E5%8C%96%E5%AD%A6', it: 'Chimica', pt: 'Qu%C3%ADmica' },
  Biology: { zh: '%E7%94%9F%E7%89%A9%E5%AD%A6', it: 'Biologia', pt: 'Biologia' },
  Medicine: { zh: '%E5%8C%BB%E5%AD%A6', it: 'Medicina', pt: 'Medicina' },
  Psychology: { zh: '%E5%BF%83%E7%90%86%E5%AD%A6', it: 'Psicologia', pt: 'Psicologia' },
  Education: { zh: '%E6%95%99%E8%82%B2', it: 'Istruzione', pt: 'Educa%C3%A7%C3%A3o' },
  History: { zh: '%E5%8E%86%E5%8F%B2', it: 'Storia', pt: 'Hist%C3%B3ria' },
  Geography: { zh: '%E5%9C%B0%E7%90%86%E5%AD%A6', it: 'Geografia', pt: 'Geografia' },
  Economy: { zh: '%E7%BB%8F%E6%B5%8E', it: 'Economia', pt: 'Economia' },
  Democracy: { zh: '%E6%B0%91%E4%B8%BB', it: 'Democrazia', pt: 'Democracia' },
  'Human rights': { zh: '%E4%BA%BA%E6%9D%83', it: 'Diritti_umani', pt: 'Direitos_humanos' },
  'Global warming': { zh: '%E5%85%A8%E7%90%83%E6%9A%96%E5%8C%96', it: 'Riscaldamento_globale', pt: 'Aquecimento_global' },
  'Renewable energy': { zh: '%E5%8F%AF%E5%86%8D%E7%94%9F%E8%83%BD%E6%BA%90', it: 'Energia_rinnovabile', pt: 'Energia_renov%C3%A1vel' },
  'Solar energy': { zh: '%E5%A4%AA%E9%98%B3%E8%83%BD', it: 'Energia_solare', pt: 'Energia_solar' },
  'Wind power': { zh: '%E9%A3%8E%E5%8A%9B%E5%8F%91%E7%94%B5', it: 'Energia_eolica', pt: 'Energia_e%C3%B3lica' },
  'Electric vehicle': { zh: '%E7%94%B5%E5%8A%A8%E6%B1%BD%E8%BD%A6', it: 'Veicolo_elettrico', pt: 'Ve%C3%ADculo_el%C3%A9trico' },
  'Public transport': { zh: '%E5%85%AC%E5%85%B1%E4%BA%A4%E9%80%9A', it: 'Trasporto_pubblico', pt: 'Transporte_p%C3%BAblico' },
  Railway: { zh: '%E9%93%81%E8%B7%AF%E8%BF%90%E8%BE%93', it: 'Ferrovia', pt: 'Transporte_ferrovi%C3%A1rio' },
  Agriculture: { zh: '%E5%86%9C%E4%B8%9A', it: 'Agricoltura', pt: 'Agricultura' },
  Food: { zh: '%E9%A3%9F%E7%89%A9', it: 'Cibo', pt: 'Alimento' },
  Music: { zh: '%E9%9F%B3%E4%B9%90', it: 'Musica', pt: 'M%C3%BAsica' },
  Literature: { zh: '%E6%96%87%E5%AD%A6', it: 'Letteratura', pt: 'Literatura' },
  Film: { zh: '%E7%94%B5%E5%BD%B1', it: 'Film', pt: 'Filme' },
  Photography: { zh: '%E6%91%84%E5%BD%B1', it: 'Fotografia', pt: 'Fotografia' },
  Architecture: { zh: '%E5%BB%BA%E7%AD%91', it: 'Architettura', pt: 'Arquitetura' },
  Engineering: { zh: '%E5%B7%A5%E7%A8%8B%E5%AD%A6', it: 'Ingegneria', pt: 'Engenharia' },
  Spaceflight: { zh: '%E8%88%AA%E5%A4%A9', it: 'Volo_spaziale', pt: 'Voo_espacial' },
  Moon: { zh: '%E6%9C%88%E7%90%83', it: 'Luna', pt: 'Lua' },
  Mars: { zh: '%E7%81%AB%E6%98%9F', it: 'Marte_(astronomia)', pt: 'Marte_(planeta)' },
  Earth: { zh: '%E5%9C%B0%E7%90%83', it: 'Terra', pt: 'Terra' },
  Ocean: { zh: '%E6%B5%B7%E6%B4%8B', it: 'Oceano', pt: 'Oceano' },
  Mountain: { zh: '%E5%B1%B1', it: 'Montagna', pt: 'Montanha' },
  Forest: { zh: '%E6%A3%AE%E6%9E%97', it: 'Foresta', pt: 'Floresta' },
  River: { zh: '%E6%B2%B3%E6%B5%81', it: 'Fiume', pt: 'Rio' },
  City: { zh: '%E5%9F%8E%E5%B8%82', it: 'Citt%C3%A0', pt: 'Cidade' },
  Museum: { zh: '%E5%8D%9A%E7%89%A9%E9%A6%86', it: 'Museo', pt: 'Museu' },
  Library: { zh: '%E5%9B%BE%E4%B9%A6%E9%A6%86', it: 'Biblioteca', pt: 'Biblioteca' },
  University: { zh: '%E5%A4%A7%E5%AD%A6', it: 'Universit%C3%A0', pt: 'Universidade' },
  Newspaper: { zh: '%E6%8A%A5%E7%BA%B8', it: 'Giornale', pt: 'Jornal' },
  Radio: { zh: '%E6%97%A0%E7%BA%BF%E7%94%B5', it: 'Radio', pt: 'R%C3%A1dio' },
  Television: { zh: '%E7%94%B5%E8%A7%86', it: 'Televisione', pt: 'Televis%C3%A3o' },
  Coffee: { zh: '%E5%92%96%E5%95%A1', it: 'Caff%C3%A8', pt: 'Caf%C3%A9' },
  'Association football': { zh: '%E8%B6%B3%E7%90%83', it: 'Calcio_(sport)', pt: 'Futebol' },
});

export const LIVE_LANGUAGE_PAGE_GROUPS = Object.freeze([
  languagePages('en', 'English'),
  languagePages('sv', 'Swedish'),
  languagePages('de', 'German'),
  languagePages('fr', 'French'),
  languagePages('nl', 'Dutch'),
]);

export const LIVE_LANGUAGE_CODES = Object.freeze(
  LIVE_LANGUAGE_PAGE_GROUPS.map((group) => group.code),
);
