// 1688 以图搜图爬虫 - MTOP逆向 + 无Cookie + 代理IP
// 基于1688项目经验，使用MTOP API进行图片搜索
const axios = require('axios');
const crypto = require('crypto');
const proxyManager = require('./proxyManager');

// ============ MTOP配置（与1688项目一致）============
const MTOP_BASE_URL = 'https://h5api.m.1688.com/h5';
const MTOP_APP_KEY = '12574478';
const MTOP_JSV = '2.7.4';
const MTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// 超时与并发策略
const SINGLE_PROXY_TIMEOUT = 12000;
const TOTAL_REQUEST_TIMEOUT = 30000;
const CONCURRENT_PROXIES = 3;
const MAX_ROUNDS = 3;

// 图片存储（内存Map）
const imageStore = new Map();
let imageIdCounter = 0;

// ============ MTOP签名算法（与1688项目一致）============
function mtopSign(token, ts, appKey, data) {
  const raw = `${token}&${ts}&${appKey}&${data}`;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

function extractTokenFromCookie(cookieStr) {
  if (!cookieStr) return null;
  const match = cookieStr.match(/_m_h5_tk=([^;]+)/);
  if (!match) return null;
  return match[1].split('_')[0];
}

function extractCookiesFromHeaders(headers) {
  const cookies = [];
  const setCookies = headers?.['set-cookie'] || headers?.['Set-Cookie'];
  if (setCookies) {
    const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
    arr.forEach((sc) => {
      const m = sc.match(/^([^=]+)=([^;]*)/);
      if (m) cookies.push(`${m[1]}=${m[2]}`);
    });
  }
  return cookies.join('; ');
}

// ============ MTOPSession（与1688项目一致）============
class MTOPSession {
  constructor(proxy = null) {
    this.proxy = proxy;
    this.token = null;
    this.cookieStr = '';
    this.agent = proxy ? proxyManager.createAgent(proxy) : null;
  }

  async login(abortSignal) {
    const ts = String(Date.now());
    const data = '{}';
    const sign = mtopSign('undefined', ts, MTOP_APP_KEY, data);
    const url = `${MTOP_BASE_URL}/mtop.1688.moga.pc.shopcard/1.0/`;
    const params = {
      jsv: MTOP_JSV, appKey: MTOP_APP_KEY, t: ts, sign,
      api: 'mtop.1688.moga.pc.shopcard', v: '1.0',
      type: 'originaljson', dataType: 'jsonp', timeout: '20000',
    };
    const headers = {
      'User-Agent': MTOP_UA, 'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://detail.1688.com', 'Referer': 'https://detail.1688.com/',
    };
    try {
      const axiosConfig = {
        method: 'POST', url, params, data: 'data={}', headers,
        timeout: SINGLE_PROXY_TIMEOUT, signal: abortSignal,
        maxRedirects: 3, validateStatus: () => true,
      };
      if (this.agent) { axiosConfig.httpsAgent = this.agent; axiosConfig.httpAgent = this.agent; }
      const resp = await axios(axiosConfig);
      const newCookies = extractCookiesFromHeaders(resp.headers);
      if (newCookies) { this.cookieStr = newCookies; this.token = extractTokenFromCookie(newCookies); }
      if (this.token) return true;
      return false;
    } catch { return false; }
  }

  async request(apiConfig, data = {}, options = {}) {
    if (!this.token) {
      const ok = await this.login(options.abortSignal);
      if (!ok) return { success: false, error: 'MTOP login失败' };
    }
    const ts = String(Date.now());
    const dataStr = JSON.stringify(data);
    const sign = mtopSign(this.token, ts, MTOP_APP_KEY, dataStr);
    const url = `${MTOP_BASE_URL}/${apiConfig.api}/${apiConfig.v}/`;
    const params = {
      jsv: MTOP_JSV, appKey: MTOP_APP_KEY, t: ts, sign,
      api: apiConfig.api, v: apiConfig.v,
      type: 'originaljson', dataType: 'jsonp', timeout: '20000',
      '_bx-login': 'new',
    };
    const headers = {
      'User-Agent': MTOP_UA, 'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://detail.1688.com', 'Referer': 'https://detail.1688.com/',
    };
    if (this.cookieStr) headers['Cookie'] = this.cookieStr;
    try {
      const axiosConfig = {
        method: 'POST', url, params, data: `data=${encodeURIComponent(dataStr)}`, headers,
        timeout: SINGLE_PROXY_TIMEOUT, signal: options.abortSignal,
        maxRedirects: 3, validateStatus: () => true,
      };
      if (this.agent) { axiosConfig.httpsAgent = this.agent; axiosConfig.httpAgent = this.agent; }
      const resp = await axios(axiosConfig);
      const newCookies = extractCookiesFromHeaders(resp.headers);
      if (newCookies) { const newToken = extractTokenFromCookie(newCookies); if (newToken) this.token = newToken; this.cookieStr = newCookies; }
      if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };
      const result = resp.data;
      const ret = Array.isArray(result?.ret) ? result.ret.join(' ') : (result?.ret || '');
      const success = ret.includes('SUCCESS');
      if (ret.includes('TOKEN_EMPTY') || ret.includes('TOKEN_EXOIRED') || ret.includes('ILLEGAL_ACCESS')) {
        if (options.maxRetries > 0) {
          this.token = null;
          return this.request(apiConfig, data, { ...options, maxRetries: options.maxRetries - 1 });
        }
      }
      return { success, data: result?.data || null, ret, raw: result };
    } catch (error) {
      const isTimeout = error.name === 'CanceledError' || error.name === 'AbortError' ||
        error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ERR_CANCELED';
      return { success: false, error: isTimeout ? '请求超时' : error.message };
    }
  }
}

// ============ 代理竞态请求（与1688项目一致）============
async function requestWithProxyRace(requestFn, options = {}) {
  const { concurrentProxies = CONCURRENT_PROXIES, maxRounds = MAX_ROUNDS, totalTimeout = TOTAL_REQUEST_TIMEOUT } = options;
  if (!proxyManager.isEnabled()) {
    const session = new MTOPSession(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), totalTimeout);
    try { return await requestFn(session, controller.signal); }
    finally { clearTimeout(timer); }
  }
  const allProxies = proxyManager.proxies.length > 0 ? proxyManager.proxies : [];
  const usedProxies = new Set();
  let lastError = null;
  for (let round = 0; round < maxRounds; round++) {
    const available = [];
    for (const p of allProxies) {
      if (!usedProxies.has(p) && !proxyManager.badProxies.has(p)) available.push(p);
    }
    if (available.length === 0) {
      usedProxies.clear();
      continue;
    }
    const batch = available.slice(0, concurrentProxies);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), totalTimeout / maxRounds);
    try {
      const results = await Promise.allSettled(
        batch.map(async (proxy) => {
          const session = new MTOPSession(proxy);
          const result = await requestFn(session, controller.signal);
          if (result.success) {
            proxyManager.markSuccess(proxy);
            usedProxies.add(proxy);
            return result;
          }
          proxyManager.markFailed(proxy);
          usedProxies.add(proxy);
          lastError = result.error || '请求失败';
          return null;
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value && r.value.success) {
          return r.value;
        }
      }
    } finally { clearTimeout(timer); }
  }
  return { success: false, error: lastError || '所有代理都失败了' };
}

// ============ 图片上传 ============
// 接受图片URL，下载并存储，返回唯一ID
async function uploadImage(imageUrl) {
  try {
    // 下载图片
    let imageData = null;
    let imageMime = 'image/jpeg';
    try {
      const resp = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        validateStatus: () => true,
      });
      if (resp.status === 200 && resp.data) {
        imageData = Buffer.from(resp.data).toString('base64');
        imageMime = resp.headers['content-type'] || 'image/jpeg';
      }
    } catch (e) {
      return { success: false, error: `下载图片失败: ${e.message}` };
    }
    if (!imageData) {
      return { success: false, error: '下载图片失败: 返回空数据' };
    }
    // 生成唯一ID
    imageIdCounter++;
    const imageId = `img_${Date.now()}_${imageIdCounter}`;
    imageStore.set(imageId, {
      url: imageUrl,
      data: imageData,
      mime: imageMime,
      createdAt: Date.now(),
    });
    // 限制存储大小，防止内存泄漏
    if (imageStore.size > 100) {
      const oldest = imageStore.keys().next().value;
      imageStore.delete(oldest);
    }
    return { success: true, data_version: '1.1', image_id: imageId, image_url: imageUrl, message: '图片上传成功' };
} catch (e) {
    return { success: false, error: `图片上传失败: ${e.message}` };
  }
}

// ============ 图片搜索（MTOP方式 - 基于ai-reverse逆向分析）============
// 使用 mtop.relationrecommend.WirelessRecommend.recommend (v2.0)
// 方法: imageSimilarSearchV2 → 直接传图片URL搜索，无需上传
// 参考: https://github.com/QuoVadis86/ai-reverse
async function searchByImageMtop(imageUrl, page = 1) {
  try {
    const APP_ID = 32517;
    const params = {
      method: 'imageSimilarSearchV2',
      beginPage: page,
      pageSize: 20,
      imageAddress: imageUrl,
      searchScene: 'pcImageSearch',
      appName: 'pctusou',
    };
    const data = { appId: APP_ID, params: JSON.stringify(params) };
    const apiConfig = { api: 'mtop.relationrecommend.WirelessRecommend.recommend', v: '2.0' };
    
    // 1. 先尝试无代理直连MTOP
    const directSession = new MTOPSession(null);
    const directResult = await directSession.request(apiConfig, data, { maxRetries: 1 });
    if (directResult.success && directResult.data) {
      console.log('[ImgSearch] MTOP直连成功 (imageSimilarSearchV2)');
      return parseImageSearchResult(directResult.data);
    }
    
    // 2. 直连失败，尝试带代理
    const proxyResult = await requestWithProxyRace(
      async (session, signal) => {
        return await session.request(apiConfig, data, { abortSignal: signal, maxRetries: 1 });
      },
      { concurrentProxies: 3, maxRounds: 2 }
    );
    if (proxyResult.success && proxyResult.data) {
      console.log('[ImgSearch] MTOP代理成功 (imageSimilarSearchV2)');
      return parseImageSearchResult(proxyResult.data);
    }
    
    return { success: false, error: 'MTOP图片搜索API失败', fallback: true };
  } catch (e) {
    return { success: false, error: `MTOP异常: ${e.message}`, fallback: true };
  }
}

// 解析图片搜索结果（基于ai-reverse的响应结构）
function parseImageSearchResult(data) {
  try {
    // 响应结构: data.data.OFFER 或 data.data.OFFER.items
    const offer = data?.data?.OFFER || data?.OFFER || {};
    const items = offer?.items || offer?.itemList || [];
    const total = offer?.found || offer?.total || items.length;
    
    const products = [];
    for (const item of items) {
      if (!item) continue;
      const product = extractImageProductFields(item);
      if (product.offerId || product.title) {
        products.push(product);
      }
    }
    
    return {
      success: true,
      data_version: '1.1',
      total,
      page: 1,
      pageSize: 20,
      products,
      source: 'mtop_image',
    };
  } catch (e) {
    return { success: false, error: `解析图片搜索结果失败: ${e.message}` };
  }
}

// 提取图片搜索结果中的商品字段
function extractImageProductFields(item) {
  // 从 trackInfo.expoData 中提取商品信息
  const expo = item?.trackInfo?.expoData || item?.expoData || {};
  const offer = item?.offer || item?.offerInfo || {};
  
  return {
    offerId: item.offerId || expo.offerId || offer.offerId || '',
    title: item.title || expo.subject || offer.subject || item.subject || '',
    price: item.price || expo.price || offer.price || '',
    image: item.image || item.imageUrl || expo.image || expo.imgUrl || '',
    url: item.url || item.detailUrl || expo.detailUrl || offer.detailUrl || '',
    seller: item.sellerName || expo.sellerName || offer.sellerName || '',
    company: item.companyName || expo.companyName || '',
    sales: item.sales || expo.sales30 || offer.sales30 || 0,
    minOrder: item.minOrderQuantity || expo.minOrderQuantity || offer.minOrderQuantity || 1,
    isGoldSupplier: item.isGoldSupplier || expo.isGoldSupplier || false,
    area: item.area || expo.area || '',
    score: item.score || expo.score || 0,
    source: 'mtop_image',
  };
}

// ============ 图片搜索（H5页面方式 - 改进版）============
async function searchByImageH5(imageUrl, page = 1) {
  try {
    const encodedUrl = encodeURIComponent(imageUrl);
    
    // 尝试多种URL格式
    const searchUrls = [
      `https://m.1688.com/offerSearch.html?imageUrl=${encodedUrl}&page=${page}`,
      `https://s.1688.com/offerSearch.html?imageUrl=${encodedUrl}&page=${page}`,
      `https://m.1688.com/offerSearch.html?imageUrl=${encodedUrl}`,
    ];
    
    let html = null;
    let directSuccess = false;
    let lastError = null;
    
    for (const searchUrl of searchUrls) {
      if (directSuccess) break;
      
      // 方式1: 直连尝试（先不通过代理）
      try {
        const directResp = await axios.get(searchUrl, {
          headers: {
            'User-Agent': MTOP_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': 'https://m.1688.com/',
          },
          timeout: 20000,
          validateStatus: () => true,
        });
        if (directResp.status === 200 && directResp.data && directResp.data.length > 1000) {
          html = directResp.data;
          directSuccess = true;
          console.log(`[ImgSearch] H5直连成功: ${searchUrl.substring(0, 80)}`);
        } else {
          lastError = `HTTP ${directResp.status} 或数据为空`;
        }
      } catch (e) {
        lastError = e.message;
        console.log(`[ImgSearch] H5直连失败: ${e.message}`);
      }
    }
    
    // 方式2: 代理方式（最大3轮，每轮3个并发）
    if (!directSuccess) {
      console.log('[ImgSearch] H5直连全部失败，尝试代理方式...');
      // 尝试MTOP Session方式访问（使用MTOP cookie）
      const result = await requestWithProxyRace(
        async (session, signal) => {
          // 先确保登录
          await session.login(signal);
          const headers = {
            'User-Agent': MTOP_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': 'https://m.1688.com/',
          };
          if (session.cookieStr) headers['Cookie'] = session.cookieStr;
          const axiosConfig = {
            method: 'GET', url: searchUrls[0], headers,
            timeout: 15000, signal,
            validateStatus: () => true,
          };
          if (session.agent) { axiosConfig.httpsAgent = session.agent; axiosConfig.httpAgent = session.agent; }
          const resp = await axios(axiosConfig);
          if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };
          if (!resp.data || resp.data.length < 1000) return { success: false, error: '返回数据为空或过短' };
          return { success: true, data: resp.data };
        },
        { concurrentProxies: 2, maxRounds: 2 }
      );
      if (result.success) {
        html = result.data;
      } else {
        return { success: false, error: `H5页面访问失败: ${result.error || lastError || '未知错误'}` };
      }
    }
    
    // 解析HTML页面 - 多层解析策略
    // 策略1: 从window.__INIT_DATA提取
    const initDataMatch = html.match(/window\.__INIT_DATA__\s*=\s*(\{[\s\S]*?\});/);
    if (initDataMatch) {
      try {
        const initData = JSON.parse(initDataMatch[1]);
        const parsed = parseH5SearchResult(initData, html);
        if (parsed.products && parsed.products.length > 0) return parsed;
      } catch {}
    }
    
    // 策略2: 从JSON-LD结构化数据提取
    const ldJsonMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    if (ldJsonMatch) {
      try {
        const ldData = JSON.parse(ldJsonMatch[1]);
        const parsed = parseH5SearchResult(ldData, html);
        if (parsed.products && parsed.products.length > 0) return parsed;
      } catch {}
    }
    
    // 策略3: 从HTML中提取商品列表（增强正则）
    return parseProductListFromHtmlEnhanced(html);
  } catch (e) {
    return { success: false, error: `H5图片搜索失败: ${e.message}` };
  }
}

// ============ 搜索结果解析 ============
function parseSearchResult(data) {
  try {
    const products = [];
    // 尝试多种可能的JSON结构
    let items = [];
    if (data.resultList) items = data.resultList;
    else if (data.result) items = Array.isArray(data.result) ? data.result : (data.result.itemList || []);
    else if (data.data) {
      items = data.data.resultList || data.data.list || data.data.itemList || data.data.items || [];
    } else if (data.list) items = data.list;
    else if (data.items) items = data.items;
    // 如果是对象，取第一个数组属性
    if (typeof items === 'object' && !Array.isArray(items)) {
      for (const key of Object.keys(items)) {
        if (Array.isArray(items[key]) && items[key].length > 0) {
          items = items[key];
          break;
        }
      }
    }
    if (!Array.isArray(items)) items = [];
    for (const item of items) {
      if (!item) continue;
      const product = extractProductFields(item);
      if (product.offerId || product.title) {
        products.push(product);
      }
    }
    return {
      success: true,
      data_version: '1.1',
      total: data.total || data.totalCount || data.totalResults || products.length,
      page: data.page || data.pageNo || 1,
      pageSize: data.pageSize || 20,
      products,
    };
  } catch (e) {
    return { success: false, error: `解析搜索结果失败: ${e.message}` };
  }
}

function parseH5SearchResult(initData, html) {
  try {
    let products = [];
    // 遍历initData的所有key，找到包含商品列表的
    if (typeof initData === 'object') {
      for (const key of Object.keys(initData)) {
        const val = initData[key];
        if (val && typeof val === 'object') {
          if (val.resultList) { products = extractProductsFromArray(val.resultList); break; }
          if (val.list) { products = extractProductsFromArray(val.list); break; }
          if (val.data && val.data.resultList) { products = extractProductsFromArray(val.data.resultList); break; }
        }
      }
    }
    // 如果还没找到，从HTML中提取
    if (products.length === 0) {
      products = parseProductListFromHtml(html).products || [];
    }
    return {
      success: products.length > 0,
      total: products.length,
      page: 1,
      pageSize: 20,
      products,
      source: 'h5_page',
    };
  } catch (e) {
    return { success: false, error: `解析H5结果失败: ${e.message}` };
  }
}

function extractProductsFromArray(arr) {
  const products = [];
  if (!Array.isArray(arr)) return products;
  for (const item of arr) {
    const product = extractProductFields(item);
    if (product.offerId || product.title) products.push(product);
  }
  return products;
}

// 从HTML中提取商品列表（正则方式）
function parseProductListFromHtml(html) {
  const products = [];
  try {
    const offerIdRegex = /\/offer\/(\d+)\.html/gi;
    const seenIds = new Set();
    let match;
    while ((match = offerIdRegex.exec(html)) !== null) {
      if (!seenIds.has(match[1])) seenIds.add(match[1]);
    }
    const titleRegex = /"subject"\s*:\s*"([^"]+)"/g;
    const titles = [];
    while ((match = titleRegex.exec(html)) !== null) titles.push(match[1]);
    const priceRegex = /"price"\s*:\s*([\d.]+)/g;
    const prices = [];
    while ((match = priceRegex.exec(html)) !== null) prices.push(parseFloat(match[1]));
    const ids = Array.from(seenIds);
    for (let i = 0; i < Math.min(ids.length, 50); i++) {
      products.push({
        offerId: ids[i] || '',
        title: titles[i] || '',
        price: prices[i] || 0,
        image: '',
        source: 'h5_regex',
      });
    }
  } catch {}
  return {
    success: products.length > 0,
    total: products.length,
    page: 1,
    pageSize: 20,
    products,
    source: 'h5_regex',
    error: products.length > 0 ? undefined : '未从HTML中解析到商品数据',
  };
}

// 增强版H5解析 - 从HTML DOM结构提取商品数据
function parseProductListFromHtmlEnhanced(html) {
  const products = [];
  const seenIds = new Set();
  try {
    // 方式1: 提取offerId
    const offerIdRegex = /\/offer\/(\d+)\.html/gi;
    const offerIds = [];
    let match;
    while ((match = offerIdRegex.exec(html)) !== null) {
      if (!seenIds.has(match[1])) {
        seenIds.add(match[1]);
        offerIds.push(match[1]);
      }
    }
    console.log(`[ImgSearch] H5解析: 找到 ${offerIds.length} 个offerId`);
    
    // 方式2: 提取商品标题（从HTML中）
    const titleRegex = /(?:alt|title)="([^"]{5,})"/g;
    const rawTitles = [];
    while ((match = titleRegex.exec(html)) !== null) {
      const t = match[1].trim();
      if (t.length > 5 && !t.match(/^(https?:\/\/|\.\/)/) && !t.includes('img') && !t.includes('pic')) {
        rawTitles.push(t);
      }
    }
    
    // 方式3: 提取价格（¥前缀）
    const priceRegex = /[¥￥](\d+\.?\d*)/g;
    const prices = [];
    const seenPrices = new Set();
    while ((match = priceRegex.exec(html)) !== null) {
      const p = parseFloat(match[1]);
      if (p > 0 && p < 999999 && !seenPrices.has(p)) {
        seenPrices.add(p);
        prices.push(p);
      }
    }
    
    // 方式4: 提取图片URL
    const imgRegex = /<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))[^"]*"/gi;
    const images = [];
    const seenImgs = new Set();
    while ((match = imgRegex.exec(html)) !== null) {
      let url = match[1];
      if (!url.startsWith('http')) {
        if (url.startsWith('//')) url = 'https:' + url;
        else continue;
      }
      if (!seenImgs.has(url)) {
        seenImgs.add(url);
        images.push(url);
      }
    }
    
    // 方式5: 提取销量（售xxx+）
    const salesRegex = /售(\d+\.?\d*)(万)?[件批]?/g;
    const sales = [];
    while ((match = salesRegex.exec(html)) !== null) {
      let s = parseFloat(match[1]);
      if (match[2] === '万') s *= 10000;
      sales.push(s);
    }
    
    // 合并数据
    const maxItems = Math.min(offerIds.length, 50);
    for (let i = 0; i < maxItems; i++) {
      const product = {
        offerId: offerIds[i] || '',
        title: '',
        price: 0,
        image: '',
        sales: 0,
        detailUrl: offerIds[i] ? `https://detail.1688.com/offer/${offerIds[i]}.html` : '',
        source: 'h5_enhanced',
      };
      // 从HTML中查找该offerId附近的标题
      if (offerIds[i]) {
        const idx = html.indexOf(offerIds[i]);
        if (idx > 0) {
          const nearby = html.substring(Math.max(0, idx - 500), idx + 500);
          // 查找附近的标题
          const nearbyTitle = nearby.match(/alt="([^"]{8,})"/) || nearby.match(/title="([^"]{8,})"/);
          if (nearbyTitle) product.title = nearbyTitle[1];
          // 查找附近的价格
          const nearbyPrice = nearby.match(/[¥￥](\d+\.?\d*)/);
          if (nearbyPrice) product.price = parseFloat(nearbyPrice[1]);
          // 查找附近的图片
          const nearbyImg = nearby.match(/src="([^"]+\.(?:jpg|jpeg|png|webp))"/i);
          if (nearbyImg) {
            let imgUrl = nearbyImg[1];
            if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
            product.image = imgUrl;
          }
        }
      }
      // 如果上面没找到，用全局列表
      if (!product.title && rawTitles[i]) product.title = rawTitles[i];
      if (!product.price && prices[i]) product.price = prices[i];
      if (!product.image && images[i]) product.image = images[i];
      if (sales[i]) product.sales = sales[i];
      
      products.push(product);
    }
  } catch {}
  
  // 如果上面的方法都没找到，回退到简单版
  if (products.length === 0) {
    return parseProductListFromHtml(html);
  }
  
  return {
    success: products.length > 0,
    total: products.length,
    page: 1,
    pageSize: 20,
    products,
    source: 'h5_enhanced',
    error: products.length > 0 ? undefined : '未从HTML中解析到商品数据',
  };
}

// 提取商品所有可用字段
function extractProductFields(item) {
  const product = {};
  // 基础字段
  if (item.offerId) product.offerId = String(item.offerId);
  if (item.id) product.offerId = String(item.id);
  if (item.itemId) product.offerId = String(item.itemId);
  if (item.subject) product.title = item.subject;
  if (item.title) product.title = item.title;
  if (item.name) product.title = item.name;
  if (item.price) product.price = parseFloat(item.price);
  if (item.salePrice) product.price = parseFloat(item.salePrice);
  if (item.salePriceStr) product.price = parseFloat(item.salePriceStr);
  if (item.image) product.image = item.image;
  if (item.imgUrl) product.image = item.imgUrl;
  if (item.imageUrl) product.image = item.imageUrl;
  if (item.picUrl) product.image = item.picUrl;
  if (item.pic_url) product.image = item.pic_url;
  if (item.img) product.image = item.img;
  // 销量
  if (item.sales) product.sales = item.sales;
  if (item.saleCount) product.sales = item.saleCount;
  if (item.monthSales) product.sales = item.monthSales;
  if (item.tradeCount) product.sales = item.tradeCount;
  // 店铺
  if (item.shopName) product.shopName = item.shopName;
  if (item.shopNameCn) product.shopName = item.shopNameCn;
  if (item.shopNameEn) product.shopName = item.shopNameEn;
  if (item.shopId) product.shopId = String(item.shopId);
  // 供应商等级
  if (item.supplierLevel) product.supplierLevel = item.supplierLevel;
  if (item.supplierType) product.supplierType = item.supplierType;
  // 评分
  if (item.rating) product.rating = item.rating;
  if (item.score) product.rating = item.score;
  if (item.evaluateScore) product.rating = item.evaluateScore;
  // 公司信息
  if (item.companyName) product.companyName = item.companyName;
  if (item.company) product.companyName = item.company;
  // 地区
  if (item.city) product.city = item.city;
  if (item.province) product.province = item.province;
  if (item.region) product.region = item.region;
  if (item.address) product.address = item.address;
  // 详情URL
  if (item.detailUrl) product.detailUrl = item.detailUrl;
  if (item.url) product.detailUrl = item.url;
  if (product.offerId && !product.detailUrl) {
    product.detailUrl = `https://detail.1688.com/offer/${product.offerId}.html`;
  }
  // 相似度
  if (item.similarity) product.similarity = item.similarity;
  if (item.score) product.similarity = item.score;
  if (item.similarityScore) product.similarity = item.similarityScore;
  // 起批量
  if (item.minOrder) product.minOrder = item.minOrder;
  if (item.minQuantity) product.minOrder = item.minQuantity;
  if (item.startQuantity) product.minOrder = item.startQuantity;
  // 单位
  if (item.unit) product.unit = item.unit;
  if (item.saleUnit) product.unit = item.saleUnit;
  // 库存
  if (item.stock) product.stock = item.stock;
  if (item.quantity) product.stock = item.quantity;
  if (item.stockCount) product.stock = item.stockCount;
  // 邮费
  if (item.freight) product.freight = item.freight;
  if (item.postage) product.freight = item.postage;
  if (item.shipping) product.freight = item.shipping;
  // 类目
  if (item.category) product.category = item.category;
  if (item.categoryName) product.category = item.categoryName;
  if (item.catName) product.category = item.catName;
  // 公司信用
  if (item.creditScore) product.creditScore = item.creditScore;
  if (item.companyCredit) product.creditScore = item.companyCredit;
  // 是否认证
  if (item.isAuthenticated !== undefined) product.isAuthenticated = item.isAuthenticated;
  if (item.isAuth !== undefined) product.isAuth = item.isAuth;
  // 其他字段
  if (item.status) product.status = item.status;
  if (item.onSale !== undefined) product.onSale = item.onSale;
  if (item.isNew !== undefined) product.isNew = item.isNew;
  if (item.recommend !== undefined) product.recommend = item.recommend;
  // 原始数据
  product.raw = item;
  return product;
}

// ============ 对外接口 ============

// 图片上传 - 接受图片URL，返回图片ID
async function uploadImageByUrl(imageUrl) {
  return await uploadImage(imageUrl);
}

// 图片搜索 - 高级搜索（自动尝试MTOP→H5→增强解析，总超时30秒）
async function searchImageAdvanced(imageUrl, page = 1) {
  const startTime = Date.now();
  const MAX_TOTAL_MS = 30000; // 总超时30秒
  
  try {
    // 尝试MTOP方式
    console.log(`[ImgSearch] 开始搜索: ${imageUrl.substring(0, 80)}`);
    const mtopResult = await timeLimit(
      searchByImageMtop(imageUrl, page),
      Math.min(MAX_TOTAL_MS / 2, 15000) // MTOP最多15秒
    );
    if (mtopResult.success) return mtopResult;
    console.log(`[ImgSearch] MTOP失败: ${mtopResult.error}`);
    
    // 检查是否已超时
    if (Date.now() - startTime >= MAX_TOTAL_MS) {
      return { success: false, error: `搜索超时: MTOP(${mtopResult.error})` };
    }
    
    // 尝试H5页面方式
    console.log('[ImgSearch] 尝试H5页面方式...');
    const remainingTime = MAX_TOTAL_MS - (Date.now() - startTime);
    const h5Result = await timeLimit(
      searchByImageH5(imageUrl, page),
      remainingTime
    );
    if (h5Result.success) {
      console.log(`[ImgSearch] H5成功: ${h5Result.products.length} 个商品`);
      return h5Result;
    }
    console.log(`[ImgSearch] H5失败: ${h5Result.error}`);
    
    return { success: false, error: `搜索失败: MTOP(${mtopResult.error}), H5(${h5Result.error})`, data_version: '1.1' };
  } catch (e) {
    return { success: false, error: `图片搜索异常: ${e.message}`, data_version: '1.1' };
  }
}

// 带超时的Promise包装
function timeLimit(promise, ms) {
  if (ms <= 0) return Promise.resolve({ success: false, error: '搜索超时' });
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve({ success: false, error: `搜索超时(${ms}ms)` }), ms))
  ]);
}

// 图片搜索 - 通过图片ID
async function searchByImageId(imageId, page = 1) {
  try {
    const stored = imageStore.get(imageId);
    if (!stored) {
      return { success: false, error: '图片ID不存在，请先上传图片' };
    }
    return await searchImageAdvanced(stored.url, page);
  } catch (e) {
    return { success: false, error: `图片搜索失败: ${e.message}` };
  }
}

// 图片搜索 - 直接接受图片URL
async function searchByImageUrl(imageUrl, page = 1) {
  return await searchImageAdvanced(imageUrl, page);
}

// 代理状态
function getProxyStatus() {
  return proxyManager.getStatus();
}

function setProxyEnabled(enabled) {
  proxyManager.setEnabled(enabled);
  return proxyManager.getStatus();
}

async function refreshProxies() {
  return await proxyManager.refreshProxies(true);
}

module.exports = {
  uploadImageByUrl,
  searchByImageId,
  searchByImageUrl,
  getProxyStatus,
  setProxyEnabled,
  refreshProxies,
};