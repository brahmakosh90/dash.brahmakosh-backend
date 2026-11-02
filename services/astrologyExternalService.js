import axios from 'axios';

const env = (name) => String(process.env[name] ?? '').trim().replace(/^["']|["']$/g, '');

const JSON_BASE_URL = process.env.ASTROLOGY_API_BASE_URL || 'https://json.astrologyapi.com/v1';
const JSON_USER_ID = env('ASTROLOGY_API_USER_ID');
const JSON_API_KEY = env('ASTROLOGY_API_KEY');

const PDF_BASE_URL = process.env.ASTROLOGY_PDF_BASE_URL || 'https://pdf.astrologyapi.com/v1';
const PDF_USER_ID = env('ASTROLOGY_PDF_USER_ID');
const PDF_API_KEY = env('ASTROLOGY_PDF_API_KEY');

const jsonClient = axios.create({
  baseURL: JSON_BASE_URL,
  headers: { 'Content-Type': 'application/json', 'x-astrologyapi-key': JSON_API_KEY },
  timeout: Number(process.env.ASTROLOGY_JSON_TIMEOUT_MS || 30000)
});

// PDF API credentials, in the order they are tried. A wrongly set (stale) dedicated PDF key must not block the
// main key from being used, so a "check the API token key" answer falls through to the next candidate.
const pdfAuthCandidates = [
  PDF_USER_ID && PDF_API_KEY && { name: 'pdf-basic', auth: { username: PDF_USER_ID, password: PDF_API_KEY } },
  PDF_API_KEY && { name: 'pdf-key-header', headers: { 'x-astrologyapi-key': PDF_API_KEY } },
  JSON_API_KEY && JSON_API_KEY !== PDF_API_KEY && { name: 'main-key-header', headers: { 'x-astrologyapi-key': JSON_API_KEY } },
  JSON_USER_ID && JSON_API_KEY && { name: 'main-basic', auth: { username: JSON_USER_ID, password: JSON_API_KEY } }
].filter(Boolean);

const pdfClient = axios.create({
  baseURL: PDF_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: Number(env('ASTROLOGY_PDF_TIMEOUT_MS') || 60000)
});

// Provider answers HTTP 200 { status:false, msg } when the key is rejected or the plan lacks the PDF API
const isCredentialRejection = (data) =>
  data && data.status === false && /token|api key|authori[sz]|subscri|credential/i.test(String(data.msg || ''));

const postPdf = async (endpoint, payload) => {
  let last = null;
  for (const candidate of pdfAuthCandidates) {
    // The provider rejects keys with HTTP 401; read that body instead of throwing so the next candidate is tried
    const res = await pdfClient.post(endpoint, payload, { headers: candidate.headers, auth: candidate.auth, validateStatus: (s) => s < 500 });
    if (res.status === 401 || isCredentialRejection(res.data) === true || /expired or invalid/i.test(String(res.data?.msg || ''))) {
      console.warn(`[AstrologyPDF] ${endpoint} rejected "${candidate.name}": ${res.data?.msg}`);
      last = { name: candidate.name, data: res.data };
      continue;
    }
    if (!isCredentialRejection(res.data)) {
      if (last) console.log(`[AstrologyPDF] accepted with "${candidate.name}" after ${last.name} was rejected`);
      return res.data;
    }
    console.warn(`[AstrologyPDF] ${endpoint} rejected "${candidate.name}": ${res.data.msg}`);
    last = { name: candidate.name, data: res.data };
  }
  return last.data;
};

const ensureJsonCreds = () => {
  if (!JSON_API_KEY) {
    const err = new Error('Astrology JSON API credentials not configured (ASTROLOGY_API_KEY)');
    err.status = 500;
    throw err;
  }
};

const ensurePdfCreds = () => {
  if (!pdfAuthCandidates.length) {
    const err = new Error('Astrology PDF API credentials not configured (ASTROLOGY_PDF_API_KEY or ASTROLOGY_API_KEY)');
    err.status = 500;
    throw err;
  }
};

export const astrologyExternalService = {
  async getDailyHoroscope(sunSign, { timezone = 5.5 } = {}) {
    ensureJsonCreds();
    const sign = String(sunSign || '').toLowerCase().trim();
    const res = await jsonClient.post(`/sun_sign_prediction/daily/${encodeURIComponent(sign)}`, { timezone });
    return res.data;
  },

  async getMonthlyHoroscope(sunSign, { timezone = 5.5 } = {}) {
    ensureJsonCreds();
    const sign = String(sunSign || '').toLowerCase().trim();
    const res = await jsonClient.post(`/horoscope_prediction/monthly/${encodeURIComponent(sign)}`, { timezone });
    return res.data;
  },

  async getMatchMakingDetailedReport(payload) {
    ensureJsonCreds();
    const res = await jsonClient.post('/match_making_detailed_report', payload);
    return res.data;
  },

  async generateKundaliPdf(payload) {
    ensurePdfCreds();
    const endpointMap = {
      mini: '/mini_horoscope_pdf/tropical',
      basic: '/basic_horoscope_pdf/tropical',
      pro: '/pro_horoscope_pdf/tropical'
    };
    const endpoint = endpointMap[payload.report_type] || '/basic_horoscope_pdf/tropical';
    return postPdf(endpoint, payload);
  },

  async generateMatchMakingPdf(payload) {
    ensurePdfCreds();
    return postPdf('/match_making_pdf/tropical', payload);
  }
};

