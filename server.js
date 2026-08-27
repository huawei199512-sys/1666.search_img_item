// 1688 以图搜图API - 图片上传 + 图片搜索
// 基于1688项目经验，使用MTOP API + H5页面方式
const express = require('express');
const cors = require('cors');
const scraperImg = require('./scraperImg');
const proxyManager = require('./proxyManager');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============ 全局错误防护 ============
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err && err.message ? err.message : err);
});

// ============ 健康检查（Render必需）============
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ============ 首页 ============
app.get('/', (req, res) => {
  res.json({
    service: '1688 Image Search API',
    version: '1.1.2',
    description: '1688以图搜图API - 图片上传 + 图片搜索',
    mode: '无Cookie + 代理IP + MTOP逆向 + H5页面解析',
    features: {
      cookie_required: false,
      proxy_mode: 'MTOP代理 + H5直连（与1688项目一致）',
      proxy_pool: '13源自动刷新代理池（每30分钟）',
      search_strategy: 'MTOP API → H5页面 → 正则提取',
    },
    endpoints: {
      upload: 'GET /api/image/upload?imageUrl=https://... → 图片ID',
      search: 'GET /api/image/search?image_id=xxx&page=1 → 搜索结果',
      search_direct: 'GET /api/image/search/direct?imageUrl=https://...&page=1 → 搜索结果（无需上传）',
      proxy_status: 'GET /api/proxy/status',
      proxy_refresh: 'POST /api/proxy/refresh',
    },
    proxy_status: proxyManager.getStatus(),
  });
});

// ============ 图片上传（GET方式，方便浏览器直接调用）============
app.get('/api/image/upload', async (req, res) => {
  try {
    const { imageUrl } = req.query;
    if (!imageUrl) {
      return res.status(400).json({ success: false, error: '请提供imageUrl参数' });
    }
    // 简单的URL格式校验
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return res.status(400).json({ success: false, error: 'imageUrl必须是有效的URL' });
    }
    console.log(`[Upload] 上传图片: ${imageUrl.substring(0, 100)}`);
    const result = await scraperImg.uploadImageByUrl(imageUrl);
    if (result.success) {
      res.json({
        success: true,
        data_version: '1.1.2',
        image_id: result.image_id,
        image_url: result.image_url,
        message: '图片上传成功',
      });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[Upload] 异常:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 图片搜索 ============
app.get('/api/image/search', async (req, res) => {
  try {
    const { image_id, page = 1 } = req.query;
    if (!image_id) {
      return res.status(400).json({ success: false, error: '请提供image_id参数' });
    }
    console.log(`[Search] 图片搜索: id=${image_id}, page=${page}`);
    const result = await scraperImg.searchByImageId(image_id, parseInt(page) || 1);
    if (result.success) {
      res.json({
        success: true,
        data_version: '1.1.2',
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        products: result.products,
        source: result.source || 'mtop',
      });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[Search] 异常:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 快捷图片搜索（直接传imageUrl） ============
app.get('/api/image/search/direct', async (req, res) => {
  try {
    const { imageUrl, page = 1 } = req.query;
    if (!imageUrl) {
      return res.status(400).json({ success: false, error: '请提供imageUrl参数' });
    }
    console.log(`[SearchDirect] 直接图片搜索: url=${imageUrl.substring(0, 100)}, page=${page}`);
    const result = await scraperImg.searchByImageUrl(decodeURIComponent(imageUrl), parseInt(page) || 1);
    if (result.success) {
      res.json({
        success: true,
        data_version: '1.1.2',
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        products: result.products,
        source: result.source || 'mtop',
      });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[SearchDirect] 异常:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 代理状态 ============
app.get('/api/proxy/status', (req, res) => {
  try {
    res.json({ success: true, data: scraperImg.getProxyStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: '获取代理状态失败' });
  }
});

// ============ 手动刷新代理池 ============
app.post('/api/proxy/refresh', async (req, res) => {
  try {
    const status = await scraperImg.refreshProxies();
    res.json({ success: true, message: '代理池刷新成功', data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 兜底路由 ============
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '接口不存在',
    available_endpoints: {
      upload: 'GET /api/image/upload?imageUrl=https://...',
      search: 'GET /api/image/search?image_id=xxx&page=1',
      search_direct: 'GET /api/image/search/direct?imageUrl=https://...&page=1',
      proxy_status: 'GET /api/proxy/status',
      proxy_refresh: 'POST /api/proxy/refresh',
    },
  });
});

// ============ 启动服务 ============
const server = app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  1688 Image Search API 服务已启动`);
  console.log(`  端口: ${PORT}`);
  console.log(`  模式: 无Cookie + 代理IP + MTOP/H5图片搜索`);
  console.log(`  代理池: 13源自动刷新（每30分钟，与1688项目一致）`);
  console.log(`  健康检查: http://localhost:${PORT}/health`);
  console.log(`  API文档: http://localhost:${PORT}/`);
  console.log(`${'='.repeat(60)}\n`);
});

// 后台初始化代理池（不阻塞服务启动）
setTimeout(async () => {
  try {
    console.log('[启动] 后台初始化代理池...');
    const proxies = await proxyManager.refreshProxies(true);
    console.log(`[启动] 代理池初始化完成: ${proxies.length} 个代理`);
    proxyManager.startAutoRefresh(30);
    console.log('[启动] 代理池自动刷新定时器已启动（每30分钟）');
  } catch (e) {
    console.error('[启动] 代理池初始化失败:', e.message);
    proxyManager.startAutoRefresh(30);
  }
}, 1000);

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[关闭] 收到SIGTERM信号');
  proxyManager.stopAutoRefresh();
  server.close(() => { process.exit(0); });
});
process.on('SIGINT', () => {
  console.log('[关闭] 收到SIGINT信号');
  proxyManager.stopAutoRefresh();
  server.close(() => { process.exit(0); });
});

module.exports = { app, server };