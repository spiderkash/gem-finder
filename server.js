require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────
// CLINICALTRIALS.GOV  (no key required)
// ─────────────────────────────────────────────
async function searchClinicalTrials(filters) {
  const { default: fetch } = await import('node-fetch');

  const phaseMap = {
    'Preclinical': 'EARLY_PHASE1',
    'Phase 1':     'PHASE1',
    'Phase 2':     'PHASE2',
  };

  const parts = [
    'format=json',
    'pageSize=100',
    'filter.overallStatus=RECRUITING|NOT_YET_RECRUITING|ACTIVE_NOT_RECRUITING',
  ];

  const keywords = (filters.modalities.length ? filters.modalities : ['CAR-T cell therapy']);
  parts.push('query.intr=' + encodeURIComponent(keywords.join(' OR ')));

  if (filters.geo === 'US') parts.push('query.locn=United+States');

  const termParts = [];
  const mappedPhases = (filters.phases || []).map(p => phaseMap[p]).filter(Boolean);
  if (mappedPhases.length) {
    const phaseExpr = mappedPhases.map(p => 'AREA[Phase]' + p).join(' OR ');
    termParts.push('(' + phaseExpr + ')');
  }
  if (filters.fromYear) {
    termParts.push('AREA[LastUpdatePostDate]RANGE[' + filters.fromYear + '-01-01,MAX]');
  }
  if (filters.indication) {
    termParts.push('(' + filters.indication + ')');
  }
  if (termParts.length) {
    parts.push('query.term=' + encodeURIComponent(termParts.join(' AND ')));
  }

  parts.push('sort=LastUpdatePostDate:desc');

  const url = 'https://clinicaltrials.gov/api/v2/studies?' + parts.join('&');
  console.log('[CT] →', url);

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text();
    console.error('[CT] error body:', body);
    throw new Error('ClinicalTrials error ' + res.status + ': ' + body.slice(0, 400));
  }
  const data = await res.json();

  return (data.studies || []).map(s => {
    const p       = s.protocolSection || {};
    const id      = p.identificationModule || {};
    const status  = p.statusModule || {};
    const sponsor = p.sponsorCollaboratorsModule || {};
    const conds   = p.conditionsModule || {};
    const arms    = p.armsInterventionsModule || {};
    const contacts= p.contactsLocationsModule || {};
    const desc    = p.descriptionModule || {};

    const centralContact = (contacts.centralContacts || [])[0] || {};
    const locations      = contacts.locations || [];
    const usLoc          = locations.find(l => l.country === 'United States') || locations[0] || {};

    return {
      _source:     'ClinicalTrials.gov',
      nctId:       id.nctId || '',
      title:       id.briefTitle || '',
      sponsor:     sponsor.leadSponsor?.name || '',
      phase:       status.phase || 'N/A',
      status:      status.overallStatus || '',
      conditions:  (conds.conditions || []).slice(0, 3).join(', '),
      interventions:(arms.interventions || []).map(i => i.name).slice(0, 3).join(', '),
      contact:     centralContact.name || '',
      contactRole: centralContact.role || '',
      contactEmail:centralContact.email || '',
      city:        usLoc.city || '',
      state:       usLoc.state || '',
      country:     usLoc.country || '',
      startDate:   status.startDateStruct?.date || '',
      summary:     (desc.briefSummary || '').slice(0, 400),
      url:         `https://clinicaltrials.gov/study/${id.nctId}`,
    };
  });
}

// ─────────────────────────────────────────────
// NIH REPORTER  (no key required)
// ─────────────────────────────────────────────
async function searchNIH(filters) {
  const { default: fetch } = await import('node-fetch');

  const modalityTerms = (filters.modalities.length ? filters.modalities : ['CAR-T']);
  const terms = [
    '(' + modalityTerms.join(' OR ') + ')',
    filters.indication,
  ].filter(Boolean).join(' AND ');

  const body = {
    criteria: {
      advanced_text_search: {
        operator: 'and',
        search_field: 'all',
        search_text: terms,
      },
      fiscal_years: Array.from(
        { length: 2026 - parseInt(filters.fromYear || 2020) },
        (_, i) => parseInt(filters.fromYear || 2020) + i
      ),
    },
    offset: 0,
    limit: 100,
    sort_field:  'project_start_date',
    sort_order:  'desc',
    include_fields: [
      'ProjectTitle', 'AbstractText', 'Organization', 'PrincipalInvestigators',
      'AwardAmount', 'FiscalYear', 'ProjectStartDate', 'ProjectEndDate',
      'ActivityCode', 'Terms', 'ApplId',
    ],
  };

  console.log('[NIH] terms:', terms);

  const res = await fetch('https://api.reporter.nih.gov/v2/projects/search', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`NIH Reporter error ${res.status}`);
  const data = await res.json();

  return (data.results || []).map(p => ({
    _source:     'NIH Reporter',
    applId:      p.appl_id,
    title:       p.project_title || '',
    org:         p.organization?.name || '',
    city:        p.organization?.city || '',
    state:       p.organization?.state || '',
    country:     p.organization?.country || 'US',
    pis:         (p.principal_investigators || []).map(pi => pi.full_name).join(', '),
    funding:     p.award_amount ? `$${Number(p.award_amount).toLocaleString()}` : 'N/A',
    fiscalYear:  p.fiscal_year,
    activityCode:p.activity_code || '',
    abstract:    (p.abstract_text || '').slice(0, 400),
    startDate:   p.project_start_date?.slice(0, 10) || '',
    endDate:     p.project_end_date?.slice(0, 10) || '',
    url:         `https://reporter.nih.gov/project-details/${p.appl_id}`,
  }));
}

// ─────────────────────────────────────────────
// PUBMED  (no key required)
// ─────────────────────────────────────────────
async function searchPubMed(filters) {
  const { default: fetch } = await import('node-fetch');

  const modalityTerms = (filters.modalities.length ? filters.modalities : ['CAR-T']);
  const terms = [
    '(' + modalityTerms.join(' OR ') + ')',
    filters.indication,
  ].filter(Boolean).join(' AND ');

  const searchParams = new URLSearchParams({
    db:      'pubmed',
    term:    terms,
    retmax:  '100',
    sort:    'pub_date',
    retmode: 'json',
    datetype:'pdat',
    mindate: filters.fromYear || '2020',
    maxdate: new Date().getFullYear().toString(),
  });

  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${searchParams}`;
  console.log('[PubMed] search →', terms);

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`PubMed search error ${searchRes.status}`);
  const searchData = await searchRes.json();
  const ids = (searchData.esearchresult?.idlist || []).slice(0, 100);
  if (!ids.length) return [];

  const BATCH = 50;
  const allResults = {};
  for (let i = 0; i < ids.length; i += BATCH) {
    const batchIds = ids.slice(i, i + BATCH);
    const summaryParams = new URLSearchParams({
      db:      'pubmed',
      id:      batchIds.join(','),
      retmode: 'json',
    });
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${summaryParams}`;
    const summaryRes = await fetch(summaryUrl);
    if (!summaryRes.ok) throw new Error(`PubMed summary error ${summaryRes.status} (batch ${i/BATCH + 1})`);
    const summaryData = await summaryRes.json();
    Object.assign(allResults, summaryData.result || {});
    if (i + BATCH < ids.length) await new Promise(r => setTimeout(r, 350));
  }

  const results = allResults;
  return ids.map(id => {
    const a = results[id] || {};
    const authors = (a.authors || []).slice(0, 3).map(au => au.name).join(', ');
    const affil   = (a.authors || []).find(au => au.authtype === 'Author')?.affiliation || '';
    return {
      _source:    'PubMed',
      pmid:       id,
      title:      a.title || '',
      authors:    authors,
      affiliation:affil,
      journal:    a.fulljournalname || a.source || '',
      pubDate:    a.pubdate || '',
      epubDate:   a.epubdate || '',
      doi:        (a.elocationid || '').replace('doi: ', ''),
      url:        `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    };
  }).filter(r => r.title);
}

// ─────────────────────────────────────────────
// SEC EDGAR  (no key required)
// ─────────────────────────────────────────────
async function searchEDGAR(filters) {
  if (!filters.edgarForms || !filters.edgarForms.length) return [];
  const { default: fetch } = await import('node-fetch');

  const keywords = [
    ...(filters.modalities.length ? filters.modalities : ['CAR-T']),
    filters.indication,
  ].filter(Boolean);

  const primaryKeyword = keywords[0] || 'CAR-T';
  const q = '"' + primaryKeyword + '"' + (filters.indication ? ' "' + filters.indication + '"' : '');
  const forms = filters.edgarForms.join(',');
  const startdt = (filters.fromYear || '2020') + '-01-01';
  const enddt   = new Date().getFullYear() + '-12-31';

  const BASE = 'https://efts.sec.gov/LATEST/search-index?q=' +
    encodeURIComponent(q) +
    '&forms=' + forms +
    '&dateRange=custom' +
    '&startdt=' + startdt +
    '&enddt='   + enddt;

  const allHits = [];
  for (const from of [0]) {
    const url = BASE + '&from=' + from;
    if (from === 0) console.log('[EDGAR] →', url);

    const res = await fetch(url, {
      headers: { 'User-Agent': 'GMP-Lead-Discovery admin@example.com' }
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[EDGAR] error:', body.slice(0, 300));
      throw new Error('EDGAR error ' + res.status);
    }
    const data = await res.json();
    const hits = data.hits?.hits || [];
    allHits.push(...hits);
    if (hits.length < 100) break;
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('[EDGAR] raw hits:', allHits.length);

  const seen = new Map();
  for (const h of allHits) {
    const s   = h._source || {};
    const raw = (s.display_names && s.display_names[0]) || '';
    const name = raw.replace(/\s*\(CIK[^)]*\)/gi, '').replace(/\s*\([A-Z0-9\-]{1,6}\)\s*$/, '').trim() || 'Unknown';
    const ticker = (raw.match(/\(([A-Z]{1,5})\)/) || [])[1] || '';
    const formType = (s.root_forms && s.root_forms[0]) || s.form || '';
    const fileDate = s.file_date || '';
    if (!seen.has(name) || fileDate > (seen.get(name).fileDate || '')) {
      seen.set(name, {
        company:   name,
        ticker,
        formType,
        fileDate,
        period:    s.period_ending || '',
        location:  (s.biz_locations && s.biz_locations[0]) || '',
        incState:  (s.inc_states && s.inc_states[0]) || '',
        cik:       (s.ciks && s.ciks[0]) || '',
        filingUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' +
                   ((s.ciks && s.ciks[0]) || encodeURIComponent(name)) +
                   '&type=' + formType +
                   '&dateb=&owner=include&count=40',
      });
    }
  }

  return [...seen.values()].sort((a, b) => b.fileDate.localeCompare(a.fileDate));
}

// ─────────────────────────────────────────────
// MAIN ROUTE
// ─────────────────────────────────────────────
app.post('/discover', async (req, res) => {
  const { filters } = req.body;
  console.log('\n=== New search ===\nFilters:', JSON.stringify(filters));

  const [ctResults, nihResults, pubmedResults, edgarResults] = await Promise.all([
    searchClinicalTrials(filters).catch(e => { console.error('[CT] failed:', e.message); return []; }),
    searchNIH(filters).catch(e => { console.error('[NIH] failed:', e.message); return []; }),
    searchPubMed(filters).catch(e => { console.error('[PubMed] failed:', e.message); return []; }),
    searchEDGAR(filters).catch(e => { console.error('[EDGAR] failed:', e.message); return []; }),
  ]);

  console.log(`Results: CT=${ctResults.length} NIH=${nihResults.length} PubMed=${pubmedResults.length} EDGAR=${edgarResults.length}`);

  const deduplicated = deduplicateAcrossSources({
    clinicalTrials: ctResults,
    nih:            nihResults,
    pubmed:         pubmedResults,
    edgar:          edgarResults,
  });

  res.json(deduplicated);
});

// ─────────────────────────────────────────────
// AI LEAD SCORING ROUTE  (Google Gemini — free tier)
// Scores saved leads relative to each other for
// GMP manufacturing fit.
// Sign up at aistudio.google.com → "Get API key"
// No credit card. Takes 60 seconds.
// Add OPENROUTER_KEY=your_key to a .env file
// ─────────────────────────────────────────────
app.post('/score-leads', async (req, res) => {
  const { leads } = req.body;
  if (!leads || leads.length < 2) {
    return res.status(400).json({ error: 'Send at least 2 leads to score.' });
  }
  if (!process.env.OPENROUTER_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_KEY not set. Add it to your .env file. Get a free key at openrouter.ai' });
  }

  const { default: fetch } = await import('node-fetch');

  // Build a compact summary of each lead for the prompt
  const leadSummaries = leads.map((lead, i) => {
    const source = lead._source || 'Unknown';
    let desc = `LEAD ${i + 1} [${source}]\nTitle: ${lead.title || lead.company || '(no title)'}\n`;

    if (source === 'ClinicalTrials.gov') {
      desc += `Sponsor: ${lead.sponsor || 'N/A'}\n`;
      desc += `Phase: ${lead.phase || 'N/A'} | Status: ${lead.status || 'N/A'}\n`;
      desc += `Conditions: ${lead.conditions || 'N/A'}\n`;
      desc += `Interventions: ${lead.interventions || 'N/A'}\n`;
      desc += `Summary: ${lead.summary || 'N/A'}\n`;
    } else if (source === 'NIH Reporter') {
      desc += `Institution: ${lead.org || 'N/A'}\n`;
      desc += `Funding: ${lead.funding || 'N/A'} | Activity: ${lead.activityCode || 'N/A'}\n`;
      desc += `PIs: ${lead.pis || 'N/A'}\n`;
      desc += `Abstract: ${lead.abstract || 'N/A'}\n`;
    } else if (source === 'PubMed') {
      desc += `Authors: ${lead.authors || 'N/A'}\n`;
      desc += `Journal: ${lead.journal || 'N/A'} | Date: ${lead.pubDate || 'N/A'}\n`;
      desc += `Affiliation: ${lead.affiliation || 'N/A'}\n`;
    } else if (source === 'SEC / EDGAR') {
      desc += `Ticker: ${lead.ticker || 'N/A'} | Form: ${lead.formType || 'N/A'}\n`;
      desc += `Location: ${lead.location || 'N/A'}\n`;
      desc += `Filed: ${lead.fileDate || 'N/A'}\n`;
    }
    return desc;
  }).join('\n---\n');

  const prompt = `You are an expert business development analyst at a GMP (Good Manufacturing Practice) cell therapy contract manufacturing organization (CMO/CDMO).

Your job is to score the following ${leads.length} leads RELATIVE TO EACH OTHER based on their likelihood to need external GMP manufacturing services. Consider:
- Clinical stage (earlier = more likely to need a CMO partner)
- Whether the sponsor/institution is academic or small biotech (more likely to outsource) vs. Big Pharma (less likely)
- Funding level and availability
- Modality complexity (CAR-T, NK cell, etc. require specialized GMP)
- Active recruitment status (active trials = immediate manufacturing need)
- How soon manufacturing would be needed

Return ONLY valid JSON — no markdown, no explanation outside the JSON — in this exact format:
{
  "scores": [
    {
      "leadIndex": 0,
      "score": 85,
      "tier": "Hot",
      "headline": "One sentence on why this is a strong lead",
      "gmpFit": "Why they likely need external GMP",
      "risk": "Main risk or downside",
      "suggestedAction": "Specific next step to engage this lead"
    }
  ],
  "summary": "2-3 sentence overview comparing the leads and recommending where to focus first"
}

Tiers: Hot (75-100), Warm (50-74), Cold (0-49).
Score them relative to each other — spread the scores out across the full range. Do not give everyone similar scores.

Here are the leads to score:

${leadSummaries}`;

  // Provider: OpenRouter free router — automatically picks from all available free models
  // Sign up at openrouter.ai (email only, no CC) and add OPENROUTER_KEY to your .env
  const PROVIDERS = [
    {
      name:    'OpenRouter (free)',
      enabled: !!process.env.OPENROUTER_KEY,
      call: () => fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openrouter/free', max_tokens: 4000, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
      }),
    },
  ].filter(p => p.enabled);

  if (!PROVIDERS.length) {
    return res.status(500).json({ error: 'No API keys configured. Add OPENROUTER_KEY to your .env file. Get a free key at openrouter.ai' });
  }

  console.log('[AI] Scoring', leads.length, 'leads — trying', PROVIDERS.length, 'provider(s)...');

  try {
    let groqRes, usedProvider;
    for (const provider of PROVIDERS) {
      console.log(`[AI] Trying: ${provider.name}`);
      groqRes = await provider.call();
      if (groqRes.ok) { usedProvider = provider.name; break; }
      const errText = await groqRes.text();
      console.log(`[AI] ${provider.name} failed (${groqRes.status}) — ${errText.slice(0, 120)}`);
      // Only move to next provider on rate-limit (429) or unavailable (503)
      if (![429, 503, 529, 404].includes(groqRes.status)) {
        throw new Error(`API error ${groqRes.status}: ${errText.slice(0, 200)}`);
      }
      await new Promise(r => setTimeout(r, 800));
    }

    if (!groqRes.ok) {
      throw new Error('All providers are currently rate-limited. Wait 60 seconds and try again.');
    }

    console.log(`[AI] Success via: ${usedProvider}`);
    const groqData = await groqRes.json();
    const raw = groqData.choices?.[0]?.message?.content || '';
    console.log('[AI] Raw response length:', raw.length);

    // Strip markdown fences if model wrapped in ```json ... ```
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Response was truncated — try to salvage complete score objects from partial JSON
      console.error('[AI] JSON parse failed, attempting salvage. Raw length:', raw.length);
      try {
        const scoresMatch = cleaned.match(/"scores"\s*:\s*(\[[\s\S]*)/);
        if (scoresMatch) {
          let arr = scoresMatch[1];
          // Close any open array/object at the truncation point
          const openBraces = (arr.match(/{/g) || []).length - (arr.match(/}/g) || []).length;
          const openBrackets = (arr.match(/\[/g) || []).length - (arr.match(/\]/g) || []).length;
          for (let i = 0; i < openBraces; i++) arr += '}';
          for (let i = 0; i < openBrackets; i++) arr += ']';
          // Drop any trailing incomplete object (no closing brace after last comma)
          arr = arr.replace(/,\s*\{[^}]*$/, ']');
          const scores = JSON.parse(arr);
          parsed = { scores, summary: 'Note: response was truncated — showing partial results.' };
        } else {
          throw new Error('Could not salvage partial JSON');
        }
      } catch (e2) {
        console.error('[AI] Salvage failed. Raw:', raw.slice(0, 500));
        throw new Error('AI returned invalid JSON. Try again.');
      }
    }

    console.log('[AI] Scored', parsed.scores?.length, 'leads successfully');
    res.json({ ...parsed, _model: usedProvider });

  } catch (err) {
    console.error('[AI] scoring failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.listen(3000, () => console.log('\n✓ Lead gen app running at http://localhost:3000\n'));

// ─────────────────────────────────────────────
// CROSS-SOURCE DEDUPLICATION
// ─────────────────────────────────────────────
function deduplicateAcrossSources(allData) {
  function normaliseName(record) {
    const raw =
      record.sponsor    ||
      record.org        ||
      record.company    ||
      record.authors    ||
      '';
    return raw
      .toLowerCase()
      .replace(/,?\s*(inc|corp|ltd|llc|plc|co|gmbh|sa|nv|bv)\.?\s*$/i, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const sources = [
    { key: 'clinicalTrials', records: allData.clinicalTrials },
    { key: 'nih',            records: allData.nih },
    { key: 'pubmed',         records: allData.pubmed },
    { key: 'edgar',          records: allData.edgar },
  ];

  const nameToSources = new Map();
  for (const { key, records } of sources) {
    for (const r of records) {
      const name = normaliseName(r);
      if (!name || name.length < 3) continue;
      if (!nameToSources.has(name)) nameToSources.set(name, new Set());
      nameToSources.get(name).add(key);
    }
  }

  const result = {};
  for (const { key, records } of sources) {
    result[key] = records.map(r => {
      const name  = normaliseName(r);
      const inSources = name ? [...nameToSources.get(name) || []].filter(s => s !== key) : [];
      return { ...r, _alsoIn: inSources };
    });
  }

  const dupeCount = [...nameToSources.values()].filter(s => s.size > 1).length;
  console.log('[Dedup] cross-source matches:', dupeCount);
  return result;
}
