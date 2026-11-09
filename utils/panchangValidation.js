// Cross-validation of the paksha returned by the panchang API against the tithi number.
// Pure functions: no I/O, safe to run synchronously inside the request path.

export const normalizePaksha = (value) => {
  const v = String(value || '').toLowerCase();
  if (/krishna|krsna|कृष्ण/.test(v)) return 'Krishna';
  if (/shukla|shukl|sukla|शुक्ल/.test(v)) return 'Shukla';
  return null;
};

/** Pull a 1-30 tithi number out of the advanced panchang response (several shapes seen in the wild). */
export const extractTithiNumber = (advancedPanchang = {}) => {
  const t = advancedPanchang.tithi;
  const candidates = [t?.details?.tithi_number, t?.tithi_number, t?.number, t?.details?.number];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n >= 1 && n <= 30) return n;
  }
  return null;
};

export const expectedPakshaFromTithi = (n) => (n >= 1 && n <= 15 ? 'Shukla' : n >= 16 && n <= 30 ? 'Krishna' : null);

const parseHour = (time) => {
  const m = /(\d{1,2}):(\d{2})/.exec(String(time || ''));
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
};

/**
 * Returns:
 *  - value:       paksha string to store/serve
 *  - discrepancy: null | { field, apiValue, calculatedValue, resolution, severity, note }
 *  - warnings:    soft heuristic flags (never change the value)
 *
 * Auto-correction is applied only when the evidence is unambiguous: a tithi number 16-30 can only be
 * Krishna paksha. A number 1-15 combined with "Krishna" is reported but NOT overridden, because some
 * providers number tithis 1-15 within each paksha.
 */
export const crossValidatePaksha = (advancedPanchang = {}, { lateMoonriseHour = Number(process.env.PANCHANG_LATE_MOONRISE_HOUR || 21) } = {}) => {
  const apiRaw = advancedPanchang.paksha || '';
  const apiPaksha = normalizePaksha(apiRaw);
  const tithiNumber = extractTithiNumber(advancedPanchang);
  const calculated = tithiNumber ? expectedPakshaFromTithi(tithiNumber) : null;
  const warnings = [];

  let value = apiRaw;
  let discrepancy = null;

  if (calculated && apiPaksha && calculated !== apiPaksha) {
    const unambiguous = tithiNumber > 15; // 16-30 => Krishna, no per-paksha numbering possible
    discrepancy = {
      field: 'paksha',
      apiValue: apiRaw,
      calculatedValue: calculated,
      resolution: unambiguous ? 'used_calculated' : 'kept_api_flagged',
      severity: 'CRITICAL',
      note: `tithi ${tithiNumber} implies ${calculated} but API returned ${apiRaw}`,
    };
    if (unambiguous) value = `${calculated} Paksha`;
  } else if (calculated && !apiPaksha) {
    discrepancy = {
      field: 'paksha', apiValue: apiRaw, calculatedValue: calculated,
      resolution: 'used_calculated', severity: 'WARN', note: 'API returned no recognisable paksha',
    };
    value = `${calculated} Paksha`;
  }

  // Soft heuristic: a very late moonrise essentially only happens in the waning half.
  const finalPaksha = normalizePaksha(value);
  const hour = parseHour(advancedPanchang.moonrise);
  if (hour !== null && hour >= lateMoonriseHour && finalPaksha === 'Shukla') {
    warnings.push(`moonrise ${advancedPanchang.moonrise} is unusually late for Shukla paksha`);
  }

  return { value, discrepancy, warnings, tithiNumber };
};
