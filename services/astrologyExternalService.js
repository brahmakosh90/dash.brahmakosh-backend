import axios from 'axios';

const JSON_BASE_URL = process.env.ASTROLOGY_API_BASE_URL || 'https://json.astrologyapi.com/v1';
const JSON_USER_ID = process.env.ASTROLOGY_API_USER_ID;
const JSON_API_KEY = process.env.ASTROLOGY_API_KEY;

const PDF_BASE_URL = process.env.ASTROLOGY_PDF_BASE_URL || 'https://pdf.astrologyapi.com/v1';
const PDF_USER_ID = process.env.ASTROLOGY_PDF_USER_ID;
const PDF_API_KEY = process.env.ASTROLOGY_PDF_API_KEY;

const jsonClient = axios.create({
  baseURL: JSON_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  auth: JSON_USER_ID && JSON_API_KEY ? { username: JSON_USER_ID, password: JSON_API_KEY } : undefined,
  timeout: Number(process.env.ASTROLOGY_JSON_TIMEOUT_MS || 30000)
});

const pdfClient = axios.create({
  baseURL: PDF_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  auth: PDF_USER_ID && PDF_API_KEY ? { username: PDF_USER_ID, password: PDF_API_KEY } : undefined,
  timeout: Number(process.env.ASTROLOGY_PDF_TIMEOUT_MS || 60000)
});

const ensureJsonCreds = () => {
  if (!JSON_USER_ID || !JSON_API_KEY) {
    const err = new Error('Astrology JSON API credentials not configured (ASTROLOGY_API_USER_ID / ASTROLOGY_API_KEY)');
    err.status = 500;
    throw err;
  }
};

const ensurePdfCreds = () => {
  if (!PDF_USER_ID || !PDF_API_KEY) {
    const err = new Error('Astrology PDF API credentials not configured (ASTROLOGY_PDF_USER_ID / ASTROLOGY_PDF_API_KEY)');
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
    const res = await pdfClient.post(endpoint, payload);
    return res.data;
  },

  async generateMatchMakingPdf(payload) {
    ensurePdfCreds();
    const res = await pdfClient.post('/match_making_pdf/tropical', payload);
    return res.data;
  }
};

