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
const TOTAL_REQUEST_TIMEOUT = 60000;
const CONCURRENT_PROXIES = 3;
const MAX_ROUNDS = 8;

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
    return { success: true, image_id: imageId, image_url: imageUrl };
  } catch (e) {
    return { success: false, error: `图片上传失败: ${e.message}` };
  }
}

// ============ 图片搜索（MTOP方式）============
async function searchByImageMtop(imageUrl, page = 1) {
  try {
    // 尝试MTOP图片搜索API
    const apiConfig = { api: 'mtop.1688.alipictures.search', v: '1.0' };
    const data = {
      imageUrl: imageUrl,
      page: page,
      pageSize: 20,
      // 图片搜索参数
      searchType: 'image',
      scene: 'imageSearch',
    };
    const result = await requestWithProxyRace(
      async (session, signal) => {
        return await session.request(apiConfig, data, { abortSignal: signal, maxRetries: 1 });
      },
      { concurrentProxies: 3, maxRounds: 5 }
    );
    if (result.success && result.data) {
      return parseSearchResult(result.data);
    }
    // 尝试其他可能的MTOP API
    const apiConfig2 = { api: 'mtop.alibaba.image.search', v: '1.0' };
    const data2 = { imgUrl: imageUrl, pageNo: page, pageSize: 20 };
    const result2 = await requestWithProxyRace(
      async (session, signal) => {
        return await session.request(apiConfig2, data2, { abortSignal: signal, maxRetries: 1 });
      },
      { concurrentProxies: 3, maxRounds: 3 }
    );
    if (result2.success && result2.data) {
      return parseSearchResult(result2.data);
    }
    return { success: false, error: 'MTOP图片搜索API失败，尝试H5页面...', fallback: true };
  } catch (e) {
    return { success: false, error: `MTOP图片搜索异常: ${e.message}`, fallback: true };
  }
}

// ============ 图片搜索（H5页面方式）============
async function searchByImageH5(imageUrl, page = 1) {
  try {
    const encodedUrl = encodeURIComponent(imageUrl);
    const searchUrl = `https://m.1688.com/offerSearch.html?imageUrl=${encodedUrl}&page=${page}`;
    const result = await requestWithProxyRace(
      async (session, signal) => {
        const headers = {
          'User-Agent': MTOP_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': 'https://m.1688.com/',
        };
        const axiosConfig = {
          method: 'GET', url: searchUrl, headers,
          timeout: 15000, signal,
          validateStatus: () => true,
        };
        if (session.agent) { axiosConfig.httpsAgent = session.agent; axiosConfig.httpAgent = session.agent; }
        const resp = await axios(axiosConfig);
        if (resp.status !== 200) return { success: false, error: `HTTP ${resp.status}` };
        return { success: true, data: resp.data };
      },
      { concurrentProxies: 3, maxRounds: 5 }
    );
    if (!result.success) return { success: false, error: result.error };
    // 解析HTML页面
    const html = result.data;
    // 尝试从window.__INIT_DATA提取
    const initDataMatch = html.match(/window\.__INIT_DATA__\s*=\s*(\{[\s\S]*?\});/);
    if (initDataMatch) {
      try {
        const initData = JSON.parse(initDataMatch[1]);
        return parseH5SearchResult(initData, html);
      } catch {}
    }
    // 尝试从JSON数据中提取搜索结果
    const searchResultMatch = html.match(/searchResult\s*:\s*(\{[\s\S]*?\})\s*[,;]/);
    if (searchResultMatch) {
      try {
        const searchData = JSON.parse(searchResultMatch[1]);
        return parseH5SearchResult(searchData, html);
      } catch {}
    }
    // 尝试从页面中提取商品列表
    return parseProductListFromHtml(html);
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
    // 匹配offerId模式: /offer/[0-9]+.html
    const offerIdRegex = /\/offer\/(\d+)\.html/gi;
    const seenIds = new Set();
    let match;
    while ((match = offerIdRegex.exec(html)) !== null) {
      if (!seenIds.has(match[1])) {
        seenIds.add(match[1]);
      }
    }
    // 匹配商品标题
    const titleRegex = /"subject"\s*:\s*"([^"]+)"/g;
    const titles = [];
    while ((match = titleRegex.exec(html)) !== null) {
      titles.push(match[1]);
    }
    // 匹配价格
    const priceRegex = /"price"\s*:\s*([\d.]+)/g;
    const prices = [];
    while ((match = priceRegex.exec(html)) !== null) {
      prices.push(parseFloat(match[1]));
    }
    // 合并数据
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

// 图片搜索 - 接受图片ID，返回搜索结果
async function searchByImageId(imageId, page = 1) {
  try {
    // 查找图片
    const stored = imageStore.get(imageId);
    if (!stored) {
      return { success: false, error: '图片ID不存在' };
    }
    const imageUrl = stored.url;
    // 先尝试MTOP方式
    const mtopResult = await searchByImageMtop(imageUrl, page);
    if (mtopResult.success) {
      return mtopResult;
    }
    // 如果MTOP失败，尝试H5页面方式
    console.log('[ImgSearch] MTOP失败，尝试H5页面方式...');
    const h5Result = await searchByImageH5(imageUrl, page);
    if (h5Result.success) {
      return h5Result;
    }
    // 返回MTOP的错误信息（更详细）
    return mtopResult;
  } catch (e) {
    return { success: false, error: `图片搜索失败: ${e.message}` };
  }
}

// 图片搜索 - 直接接受图片URL
async function searchByImageUrl(imageUrl, page = 1) {
  try {
    const mtopResult = await searchByImageMtop(imageUrl, page);
    if (mtopResult.success) return mtopResult;
    console.log('[ImgSearch] MTOP失败，尝试H5页面方式...');
    return await searchByImageH5(imageUrl, page);
  } catch (e) {
    return { success: false, error: `图片搜索失败: ${e.message}` };
  }
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