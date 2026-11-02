// src/services/panchangService.js

import axios from 'axios';
import Panchang from '../models/Panchang.js';

class PanchangService {
  constructor() {
    // Astrology API configuration
    this.baseUrl = process.env.ASTROLOGY_API_BASE_URL || 'https://json.astrologyapi.com/v1';
    this.apiUserId = process.env.ASTROLOGY_API_USER_ID;
    this.apiKey = process.env.ASTROLOGY_API_KEY;
    
    // Create axios instance with basic auth
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-astrologyapi-key': this.apiKey
      },
      timeout: 30000
    });
  }

  /**
   * Retry helper for AWS/first-hit warmup
   */
  async withRetry(fn, retries = 2) {
    try {
      return await fn();
    } catch (err) {
      if (retries > 0 && (err.message?.includes('first') || err.code === 'ECONNREFUSED' || err.response?.status >= 500)) {
        console.log('[Panchang Service] Retrying after initial failure...');
        await new Promise(r => setTimeout(r, 1500));
        return this.withRetry(fn, retries - 1);
      }
      throw err;
    }
  }

  /**
   * Parse user birth data for nakshatra API. Returns request object or null if incomplete.
   */
  parseBirthRequestData(userProfile) {
    if (!userProfile) return null;
    const dob = userProfile.dob;
    const timeOfBirth = (userProfile.timeOfBirth || '').toString().trim();
    const lat = userProfile.latitude;
    const lon = userProfile.longitude;

    if (!dob || isNaN(new Date(dob).getTime())) return null;
    const d = new Date(dob);
    let hour = 12, min = 0;
    if (timeOfBirth) {
      const withAmPm = timeOfBirth.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
      if (withAmPm) {
        hour = parseInt(withAmPm[1], 10);
        min = parseInt(withAmPm[2], 10);
        const ampm = (withAmPm[4] || '').toUpperCase();
        if (ampm === 'PM' && hour !== 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
      } else {
        const parts = timeOfBirth.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (parts) {
          hour = parseInt(parts[1], 10);
          min = parseInt(parts[2], 10);
        }
      }
    }
    if (lat == null || lon == null || isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) return null;

    return {
      day: d.getDate(),
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      hour,
      min,
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      tzone: 5.5
    };
  }

  /**
   * Get list of missing birth fields needed for personalized nakshatra prediction.
   * Uses resolvedProfile (after geocoding placeOfBirth if needed) so that having
   * placeOfBirth string counts as place provided when geocoding succeeds.
   */
  getMissingBirthFields(userProfile, resolvedProfile = null) {
    const profile = resolvedProfile || userProfile;
    const missing = [];
    if (!userProfile) {
      return ['dateOfBirth', 'timeOfBirth', 'placeOfBirth'];
    }
    if (!userProfile.dob || isNaN(new Date(userProfile.dob).getTime())) missing.push('dateOfBirth');
    if (!(userProfile.timeOfBirth || '').toString().trim()) missing.push('timeOfBirth');
    const lat = profile?.latitude;
    const lon = profile?.longitude;
    if (lat == null || lon == null || isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) {
      missing.push('placeOfBirth');
    }
    return missing;
  }

  /**
   * Geocode a place name to coordinates using Google Geocoding API.
   * Returns { latitude, longitude } or null if not configured or no result.
   */
  async geocodePlace(placeName) {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey || !(placeName && String(placeName).trim())) return null;
    try {
      const response = await axios.get(
        `https://maps.googleapis.com/maps/api/geocode/json`,
        {
          params: { address: String(placeName).trim(), key: apiKey },
          timeout: 10000
        }
      );
      const data = response.data;
      if (data.status !== 'OK' || !data.results?.length) return null;
      const loc = data.results[0].geometry?.location;
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
      return { latitude: loc.lat, longitude: loc.lng };
    } catch (err) {
      console.warn('[Panchang Service] Geocode failed for place:', placeName, err.message);
      return null;
    }
  }

  /**
   * Resolve birth-place coordinates from profile. If profile has placeOfBirth string
   * but no latitude/longitude, geocode and return profile with coordinates set.
   * Caller should use returned profile for parseBirthRequestData / getMissingBirthFields.
   */
  async resolveBirthPlaceProfile(userProfile) {
    if (!userProfile) return null;
    const hasCoords = userProfile.latitude != null && userProfile.longitude != null &&
      !isNaN(parseFloat(userProfile.latitude)) && !isNaN(parseFloat(userProfile.longitude));
    if (hasCoords) return userProfile;
    const place = (userProfile.placeOfBirth || '').toString().trim();
    if (!place) return userProfile;
    const coords = await this.geocodePlace(place);
    if (!coords) return userProfile;
    return { ...userProfile, latitude: coords.latitude, longitude: coords.longitude };
  }

  /**
   * Main method: Get complete panchang data
   * Uses current date and user's live location from request
   * Checks DB first (for today's date), then fetches from API if needed
   * @param {object} userProfile - Optional. profile.dob, profile.timeOfBirth, profile.latitude, profile.longitude for personalized nakshatra
   */
  async getCompletePanchangData(userId, currentDate, latitude, longitude, forceRefresh = false, userProfile = null, options = {}) {
    try {
      // Step 1: Validate input
      this.validatePanchangInput(currentDate, latitude, longitude);

      // Timezone (hours from UTC) the date/time is interpreted in. Defaults to IST.
      const tzone = this.resolveTzone(options.tzone);

      // Date string for cache key, computed in the user's timezone (not the server's)
      const todayKey = this.getTodayKey(currentDate, tzone);

      // Step 2: Check if data exists in DB for today (unless force refresh)
      if (!forceRefresh) {
        const existingData = await Panchang.findOne({ 
          userId,
          dateKey: todayKey 
        });
        
        if (existingData && this.isSameLocation(existingData.location, latitude, longitude)) {
          console.log('[Panchang Service] Returning cached data from DB for user:', userId, 'Date:', todayKey);
          return this.formatPanchangResponse(existingData);
        }
        console.log('[Panchang Service] No usable cached data for', todayKey, '- fetching from API');
      } else {
        console.log('[Panchang Service] Force refresh requested, fetching fresh data from API');
      }

      // Step 3: Prepare current date and location data for API
      const requestData = this.prepareRequestData(currentDate, latitude, longitude, tzone);

      // Step 4: Resolve birth place (geocode placeOfBirth if no lat/lon), then fetch nakshatra or return missingFields
      const resolvedProfile = await this.resolveBirthPlaceProfile(userProfile);
      const birthData = this.parseBirthRequestData(resolvedProfile);
      let nakshatraPredictionData;
      if (birthData) {
        nakshatraPredictionData = await this.fetchDailyNakshatraPrediction(birthData);
        console.log('[Panchang Service] Nakshatra prediction fetched with birth data');
      } else {
        const missingFields = this.getMissingBirthFields(userProfile, resolvedProfile);
        nakshatraPredictionData = {
          missingFields,
          message: 'Birth details (dateOfBirth, timeOfBirth, placeOfBirth) are required for personalized daily nakshatra prediction'
        };
        console.log('[Panchang Service] Birth data incomplete, returning missingFields:', missingFields);
      }

      // Step 4b: Fetch basic, advanced, chaughadiya in parallel
      console.log('[Panchang Service] Fetching Panchang API endpoints for date:', todayKey);
      const [basicPanchangData, advancedPanchangData, chaughadiyaData] = await Promise.all([
        this.fetchBasicPanchang(requestData),
        this.fetchAdvancedPanchangSunrise(requestData),
        this.fetchChaughadiyaMuhurta(requestData)
      ]);

      console.log('[Panchang Service] All API calls completed successfully');

      // Step 5: Process and structure the data
      const panchangData = this.processPanchangData(
        userId,
        todayKey,
        currentDate,
        latitude,
        longitude,
        basicPanchangData,
        advancedPanchangData,
        chaughadiyaData,
        nakshatraPredictionData
      );

      // Step 6: Save to database (upsert for today's date)
      const savedData = await Panchang.findOneAndUpdate(
        { userId, dateKey: todayKey },
        panchangData,
        { upsert: true, new: true }
      );

      console.log('[Panchang Service] Data saved to DB for user:', userId, 'Date:', todayKey);

      // Step 7: Return formatted response
      return this.formatPanchangResponse(savedData);

    } catch (error) {
      console.error('[Panchang Service] Error:', error);
      throw new Error(`Failed to get panchang data: ${error.message}`);
    }
  }

  /**
   * Validate panchang input
   */
  validatePanchangInput(currentDate, latitude, longitude) {
    if (!currentDate) {
      throw new Error('Current date is required');
    }
    
    if (latitude === null || latitude === undefined) {
      throw new Error('Latitude is required');
    }
    
    if (longitude === null || longitude === undefined) {
      throw new Error('Longitude is required');
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new Error('Latitude and longitude must be valid numbers');
    }

    if (lat < -90 || lat > 90) {
      throw new Error('Latitude must be between -90 and 90');
    }

    if (lon < -180 || lon > 180) {
      throw new Error('Longitude must be between -180 and 180');
    }
  }

  /**
   * Timezone offset in hours from UTC (e.g. 5.5). Falls back to IST for missing/invalid values.
   */
  resolveTzone(tzone) {
    const n = Number(tzone);
    return tzone !== undefined && tzone !== null && tzone !== '' && Number.isFinite(n) && n >= -12 && n <= 14 ? n : 5.5;
  }

  /**
   * Calendar date and clock time of `date` as seen in timezone `tzone`.
   * Independent of the server's own timezone (production servers usually run in UTC).
   */
  zonedParts(date, tzone = 5.5) {
    const shifted = new Date(new Date(date).getTime() + tzone * 3600 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      min: shifted.getUTCMinutes()
    };
  }

  /**
   * Date key for caching (YYYY-MM-DD) in the given timezone
   */
  getTodayKey(date, tzone = 5.5) {
    const { year, month, day } = this.zonedParts(date, tzone);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  /**
   * True when cached coordinates are close enough (~50km) to the requested ones.
   * Cached docs without a stored location are treated as a match (legacy records).
   */
  isSameLocation(cached, latitude, longitude) {
    if (cached?.latitude == null || cached?.longitude == null) return true;
    return Math.abs(cached.latitude - parseFloat(latitude)) < 0.5 &&
           Math.abs(cached.longitude - parseFloat(longitude)) < 0.5;
  }

  /**
   * Prepare request data for API (x-www-form-urlencoded format).
   * A date-only request (UTC midnight, e.g. new Date('2026-01-31')) is calculated at local noon -
   * midnight is before sunrise and would return the previous day's tithi/nakshatra.
   */
  prepareRequestData(currentDate, latitude, longitude, tzone = 5.5) {
    const d = new Date(currentDate);
    const dateOnly = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
    const parts = dateOnly ? this.zonedParts(new Date(d.getTime() - tzone * 3600 * 1000 + 12 * 3600 * 1000), tzone) : this.zonedParts(d, tzone);

    return {
      day: parts.day,
      month: parts.month,
      year: parts.year,
      hour: parts.hour,
      min: parts.min,
      lat: parseFloat(latitude),
      lon: parseFloat(longitude),
      tzone
    };
  }

  /**
   * Convert object to URL-encoded format
   */
  toUrlEncoded(data) {
    return Object.keys(data)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
      .join('&');
  }

  /**
   * Fetch basic panchang from API (with retry for AWS first-hit)
   */
  async fetchBasicPanchang(requestData) {
    return this.withRetry(async () => {
      console.log('[Panchang Service] Fetching basic_panchang...');
      const response = await this.apiClient.post('/basic_panchang', this.toUrlEncoded(requestData));
      return response.data;
    });
  }

  /**
   * Fetch advanced panchang sunrise from API
   */
  async fetchAdvancedPanchangSunrise(requestData) {
    return this.withRetry(async () => {
      console.log('[Panchang Service] Fetching advanced_panchang/sunrise...');
      const response = await this.apiClient.post('/advanced_panchang/sunrise', this.toUrlEncoded(requestData));
      return response.data;
    });
  }

  /**
   * Fetch chaughadiya muhurta from API
   */
  async fetchChaughadiyaMuhurta(requestData) {
    return this.withRetry(async () => {
      console.log('[Panchang Service] Fetching chaughadiya_muhurta...');
      const response = await this.apiClient.post('/chaughadiya_muhurta', this.toUrlEncoded(requestData));
      return response.data;
    });
  }

  /**
   * Fetch daily nakshatra prediction from API
   */
  async fetchDailyNakshatraPrediction(requestData) {
    return this.withRetry(async () => {
      console.log('[Panchang Service] Fetching daily_nakshatra_prediction...');
      const response = await this.apiClient.post('/daily_nakshatra_prediction', this.toUrlEncoded(requestData));
      return response.data;
    });
  }

  /**
   * Process and structure panchang data from all 4 API responses
   */
  processPanchangData(userId, dateKey, currentDate, latitude, longitude, basicPanchang, advancedPanchang, chaughadiya, nakshatraPrediction) {
    return {
      userId,
      dateKey,
      requestDate: new Date(currentDate),
      location: {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude)
      },
      basicPanchang: {
        day: basicPanchang.day || '',
        tithi: basicPanchang.tithi || '',
        nakshatra: basicPanchang.nakshatra || '',
        yog: basicPanchang.yog || '',
        karan: basicPanchang.karan || '',
        sunrise: basicPanchang.sunrise || '',
        sunset: basicPanchang.sunset || '',
        vedicSunrise: basicPanchang.vedic_sunrise || '',
        vedicSunset: basicPanchang.vedic_sunset || ''
      },
      advancedPanchang: {
        day: advancedPanchang.day || '',
        sunrise: advancedPanchang.sunrise || '',
        sunset: advancedPanchang.sunset || '',
        moonrise: advancedPanchang.moonrise || '',
        moonset: advancedPanchang.moonset || '',
        vedicSunrise: advancedPanchang.vedic_sunrise || '',
        vedicSunset: advancedPanchang.vedic_sunset || '',
        sunSignChange: advancedPanchang.sun_sign_change || '',
        moonSignChange: advancedPanchang.moon_sign_change || '',
        ayana: advancedPanchang.ayana || '',
        paksha: advancedPanchang.paksha || '',
        ritu: advancedPanchang.ritu || '',
        sunSign: advancedPanchang.sun_sign || '',
        moonSign: advancedPanchang.moon_sign || '',
        panchangYog: advancedPanchang.panchang_yog || '',
        vikramSamvat: advancedPanchang.vikram_samvat || 0,
        shakaSamvat: advancedPanchang.shaka_samvat || 0,
        vkramSamvatName: advancedPanchang.vkram_samvat_name || '',
        shakaSamvatName: advancedPanchang.shaka_samvat_name || '',
        dishaShool: advancedPanchang.disha_shool || '',
        dishaShoolRemedies: advancedPanchang.disha_shool_remedies || '',
        nakShool: {
          direction: advancedPanchang.nak_shool?.direction || '',
          remedies: advancedPanchang.nak_shool?.remedies || ''
        },
        moonNivas: advancedPanchang.moon_nivas || '',
        hinduMaah: {
          adhikStatus: advancedPanchang.hindu_maah?.adhik_status || false,
          purnimanta: advancedPanchang.hindu_maah?.purnimanta || '',
          amanta: advancedPanchang.hindu_maah?.amanta || '',
          amantaId: advancedPanchang.hindu_maah?.amanta_id || 0,
          purnimantaId: advancedPanchang.hindu_maah?.purnimanta_id || 0
        },
        abhijitMuhurta: {
          start: advancedPanchang.abhijit_muhurta?.start || '',
          end: advancedPanchang.abhijit_muhurta?.end || ''
        },
        rahukaal: {
          start: advancedPanchang.rahukaal?.start || '',
          end: advancedPanchang.rahukaal?.end || ''
        },
        guliKaal: {
          start: advancedPanchang.guliKaal?.start || '',
          end: advancedPanchang.guliKaal?.end || ''
        },
        yamghantKaal: {
          start: advancedPanchang.yamghant_kaal?.start || '',
          end: advancedPanchang.yamghant_kaal?.end || ''
        },
        panchang: {
          tithi: advancedPanchang.tithi || {},
          nakshatra: advancedPanchang.nakshatra || {},
          yog: advancedPanchang.yog || {},
          karan: advancedPanchang.karan || {}
        }
      },
      chaughadiyaMuhurta: {
        day: chaughadiya.chaughadiya?.day || [],
        night: chaughadiya.chaughadiya?.night || []
      },
      dailyNakshatraPrediction: nakshatraPrediction.missingFields
        ? { missingFields: nakshatraPrediction.missingFields, message: nakshatraPrediction.message }
        : {
            birthMoonSign: nakshatraPrediction.birth_moon_sign || '',
            birthMoonNakshatra: nakshatraPrediction.birth_moon_nakshatra || '',
            predictionDate: nakshatraPrediction.prediction_date || '',
            nakshatra: nakshatraPrediction.nakshatra || '',
            prediction: nakshatraPrediction.prediction || {},
            bot_response: nakshatraPrediction.bot_response || '',
            mood: nakshatraPrediction.mood || '',
            mood_percentage: nakshatraPrediction.mood_percentage || '',
            lucky_color: nakshatraPrediction.lucky_color || [],
            lucky_number: nakshatraPrediction.lucky_number || [],
            lucky_time: nakshatraPrediction.lucky_time || ''
          },
      lastCalculated: new Date(),
      calculationSource: 'api'
    };
  }

  /**
   * Format panchang response from DB document
   */
  formatPanchangResponse(panchangDoc) {
    const obj = panchangDoc.toObject();
    
    return {
      dateKey: obj.dateKey,
      requestDate: obj.requestDate,
      location: obj.location,
      basicPanchang: obj.basicPanchang,
      advancedPanchang: obj.advancedPanchang,
      chaughadiyaMuhurta: obj.chaughadiyaMuhurta,
      dailyNakshatraPrediction: obj.dailyNakshatraPrediction,
      lastCalculated: obj.lastCalculated,
      calculationSource: obj.calculationSource
    };
  }

  /**
   * Delete old panchang data for a user (optional cleanup)
   */
  async deleteOldPanchangData(userId, daysToKeep = 7) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await Panchang.deleteMany({ 
        userId,
        requestDate: { $lt: cutoffDate }
      });

      console.log(`[Panchang Service] Deleted ${result.deletedCount} old panchang records for user:`, userId);
      return result.deletedCount;
    } catch (error) {
      console.error('[Panchang Service] Delete old data error:', error);
      throw error;
    }
  }

  /**
   * Delete all panchang data for a user
   */
  async deletePanchangData(userId) {
    try {
      await Panchang.deleteMany({ userId });
      console.log('[Panchang Service] Deleted all panchang data for user:', userId);
    } catch (error) {
      console.error('[Panchang Service] Delete error:', error);
      throw error;
    }
  }

  /**
   * Refresh panchang data (force recalculation from API)
   * @param {object} userProfile - Optional. profile.dob, profile.timeOfBirth, profile.latitude, profile.longitude for personalized nakshatra
   */
  async refreshPanchangData(userId, currentDate, latitude, longitude, userProfile = null) {
    console.log('[Panchang Service] Refreshing data for user:', userId);
    return this.getCompletePanchangData(userId, currentDate, latitude, longitude, true, userProfile);
  }
}

export default new PanchangService();