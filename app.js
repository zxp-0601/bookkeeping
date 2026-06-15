// 导入 Node.js 内置模块
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 18765;                    // 服务端口号
const DB_PATH = path.join(__dirname, 'records.json');   // 数据文件路径
const INDEX_PATH = path.join(__dirname, 'index.html');   // 前端页面路径

/**
 * 读取数据库（JSON 文件）
 * @returns {Array} 订单记录数组
 */
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch(e) { return []; }
}

/**
 * 写入数据库（JSON 文件）
 * @param {Array} data - 订单记录数组
 */
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// 如果数据文件不存在则初始化空数组
if (!fs.existsSync(DB_PATH)) {
  writeDB([]);
  console.log(`  📄  初始化数据文件: ${DB_PATH}`);
}

/**
 * 生成下一个订单ID（最大ID + 1）
 * @param {Array} records - 现有订单数组
 * @returns {number} 新ID
 */
function nextId(records) {
  return records.length > 0 ? Math.max(...records.map(r => r.id)) + 1 : 1;
}

/**
 * 计算合作费（分成）：(销售额 - 成本 - 快递费 - 手续费) / 2
 * @param {number} sales - 销售额
 * @param {number} cost - 成本
 * @param {number} shipping - 快递费
 * @param {number} service - 手续费
 * @returns {number} 合作费
 */
function calcSplit(sales, cost, shipping, service) {
  const beforeSplit = sales - cost - shipping - service;
  return beforeSplit / 2;
}

/**
 * 计算单笔利润（= 合作费，两者相等）
 * @param {Object} r - 订单对象
 * @returns {number} 单笔利润
 */
function calcProfit(r) {
  return calcSplit(r.sales_amount, r.cost, r.shipping_fee, r.service_fee);
}

/**
 * 按渠道分组统计销售额和利润
 * @param {Array} records - 所有订单记录
 * @returns {Object} 包含分渠道统计行和总计
 */
function getStats(records) {
  let total_quantity = 0, total_sales = 0, total_cost = 0;
  let total_shipping = 0, total_service = 0, total_cooperation = 0;
  let total_profit = 0;
  const channelGroups = {};

  records.forEach(r => {
    total_quantity += r.quantity;
    total_sales += r.sales_amount;
    total_cost += r.cost;
    total_shipping += r.shipping_fee;
    total_service += r.service_fee;
    total_cooperation += r.cooperation_fee;
    total_profit += calcProfit(r);

    const ch = r.channel || '其他';
    if (!channelGroups[ch]) channelGroups[ch] = { channel: ch, count: 0, sales: 0, profit: 0 };
    channelGroups[ch].count++;
    channelGroups[ch].sales += r.sales_amount;
    channelGroups[ch].profit += calcProfit(r);
  });

  return {
    rows: Object.values(channelGroups).sort((a, b) => b.sales - a.sales),
    total: {
      total_quantity, total_sales, total_cost,
      total_shipping, total_service, total_cooperation,
      total_profit, total_count: records.length
    }
  };
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/index.html';
  const params = url.searchParams;

  // CORS 跨域请求头
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // 预检请求直接返回
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  /**
   * 返回 JSON 响应
   * @param {*} data - 响应数据
   * @param {number} status - HTTP 状态码，默认 200
   */
  function json(data, status=200) {
    const body = JSON.stringify(data);
    res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  /**
   * 读取并解析请求体中的 JSON 数据
   * @returns {Promise<Object>}
   */
  function readBody() {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
  }

  // 返回前端页面 index.html
  if (req.method === 'GET' && (pathname === '/index.html' || pathname === '/')) {
    fs.readFile(INDEX_PATH, (err, data) => {
      if (err) { res.writeHead(500); return res.end('Internal Error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // === API: GET /api/records — 查询订单列表，支持日期范围、状态、关键词筛选 ===
  if (req.method === 'GET' && pathname === '/api/records') {
    let records = readDB();
    const from = params.get('from');
    const to = params.get('to');
    const status = params.get('status');
    const search = params.get('search');
    if (from) records = records.filter(r => r.date >= from);
    if (to) records = records.filter(r => r.date <= to);
    if (status) records = records.filter(r => r.status === status);
    if (search) {
      const kw = search.toLowerCase();
      records = records.filter(r =>
        (r.customer_name && r.customer_name.toLowerCase().includes(kw)) ||
        (r.platform_nickname && r.platform_nickname.toLowerCase().includes(kw))
      );
    }
    records.sort((a, b) => b.id - a.id);
    records = records.map(r => ({ ...r, profit: calcProfit(r) }));
    return json({ ok: true, data: records });
  }

  // === API: POST /api/records — 新增订单 ===
  if (req.method === 'POST' && pathname === '/api/records') {
    readBody().then(d => {
      const qty = parseInt(d.quantity) || 1;
      const sales = parseFloat(d.sales_amount) || 0;
      const cost = parseFloat(d.cost) || 0;
      const shipping = parseFloat(d.shipping_fee) || 0;
      const service = parseFloat(d.service_fee) || 0;
      // 如果前端传了合作费则使用用户输入的值，否则自动计算
      const coop = d.cooperation_fee !== undefined
        ? parseFloat(d.cooperation_fee)
        : calcSplit(sales, cost, shipping, service);
      if (sales <= 0) return json({ ok: false, error: '请输入销售额' }, 400);
      if (qty <= 0) return json({ ok: false, error: '数量必须大于0' }, 400);
      const records = readDB();
      const record = {
        id: nextId(records),
        quantity: qty,
        sales_amount: sales,
        cost,
        shipping_fee: shipping,
        service_fee: service,
        cooperation_fee: coop,
        status: d.status || '未完成',
        customer_name: d.customer_name || '',
        platform_nickname: d.platform_nickname || '',
        tracking_number: d.tracking_number || '',
        product_spec: d.product_spec || '',
        recipient_address: d.recipient_address || '',
        channel: d.channel || '',
        date: d.date || new Date().toISOString().slice(0, 10),
        created_at: new Date().toLocaleString('zh-CN', { hour12: false })
      };
      records.push(record);
      writeDB(records);
      json({ ok: true, data: { id: record.id, profit: calcProfit(record), cooperation_fee: coop } }, 201);
    }).catch(() => json({ ok: false, error: '请求格式错误' }, 400));
    return;
  }

  // === API: PUT /api/records?id=xx — 修改订单 ===
  if (req.method === 'PUT' && pathname.startsWith('/api/records') && params.get('id')) {
    readBody().then(d => {
      const id = parseInt(params.get('id'));
      const records = readDB();
      const idx = records.findIndex(r => r.id === id);
      if (idx === -1) return json({ ok: false, error: '记录不存在' }, 404);
      const record = records[idx];
      if (d.status !== undefined) record.status = d.status;
      if (d.tracking_number !== undefined) record.tracking_number = d.tracking_number;
      if (d.customer_name !== undefined) record.customer_name = d.customer_name;
      if (d.platform_nickname !== undefined) record.platform_nickname = d.platform_nickname;
      if (d.product_spec !== undefined) record.product_spec = d.product_spec;
      if (d.recipient_address !== undefined) record.recipient_address = d.recipient_address;
      if (d.channel !== undefined) record.channel = d.channel;
      if (d.date !== undefined) record.date = d.date;
      if (d.quantity !== undefined) record.quantity = parseInt(d.quantity) || record.quantity;
      if (d.sales_amount !== undefined) record.sales_amount = parseFloat(d.sales_amount) || record.sales_amount;
      if (d.cost !== undefined) record.cost = parseFloat(d.cost) || 0;
      if (d.shipping_fee !== undefined) record.shipping_fee = parseFloat(d.shipping_fee) || 0;
      if (d.service_fee !== undefined) record.service_fee = parseFloat(d.service_fee) || 0;
      // 如果前端传了合作费则使用用户输入的值，否则自动计算
      if (d.cooperation_fee !== undefined) {
        record.cooperation_fee = parseFloat(d.cooperation_fee) || 0;
      } else {
        record.cooperation_fee = calcSplit(record.sales_amount, record.cost, record.shipping_fee, record.service_fee);
      }
      records[idx] = record;
      writeDB(records);
      json({ ok: true, data: { id: record.id, profit: calcProfit(record), cooperation_fee: record.cooperation_fee } });
    }).catch(() => json({ ok: false, error: '请求格式错误' }, 400));
    return;
  }

  // === API: POST /api/records/batch — 批量导入订单 ===
  if (req.method === 'POST' && pathname === '/api/records/batch') {
    readBody().then(d => {
      const items = d.records || [];
      if (!items.length) return json({ ok: false, error: '没有数据' }, 400);
      const records = readDB();
      const added = [];
      items.forEach(item => {
        const qty = parseInt(item.quantity) || 1;
        const sales = parseFloat(item.sales_amount) || 0;
        const cost = parseFloat(item.cost) || 0;
        const shipping = parseFloat(item.shipping_fee) || 0;
        const service = parseFloat(item.service_fee) || 0;
        // 如果导入数据中带了合作费则使用用户输入的值，否则自动计算
        const coop = item.cooperation_fee !== undefined
          ? parseFloat(item.cooperation_fee)
          : calcSplit(sales, cost, shipping, service);
        const record = {
          id: nextId(records),
          quantity: qty,
          sales_amount: sales,
          cost,
          shipping_fee: shipping,
          service_fee: service,
          cooperation_fee: coop,
          status: (item.status && item.status.trim()) ? item.status : '未完成',
          customer_name: item.customer_name || '',
          platform_nickname: item.platform_nickname || '',
          tracking_number: item.tracking_number || '',
          product_spec: item.product_spec || '',
          recipient_address: item.recipient_address || '',
          channel: item.channel || '',
          date: item.date || new Date().toISOString().slice(0, 10),
          created_at: new Date().toLocaleString('zh-CN', { hour12: false })
        };
        records.push(record);
        added.push(record);
      });
      writeDB(records);
      json({ ok: true, data: { count: added.length } }, 201);
    }).catch(() => json({ ok: false, error: '请求格式错误' }, 400));
    return;
  }

  // === API: DELETE /api/records?id=xx — 删除单条订单记录 ===
  if (req.method === 'DELETE' && pathname === '/api/records') {
    const id = parseInt(params.get('id'));
    if (!id) return json({ ok: false, error: '请指定ID' }, 400);
    let records = readDB();
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return json({ ok: false, error: '记录不存在' }, 404);
    records.splice(idx, 1);
    writeDB(records);
    return json({ ok: true, message: '已删除' });
  }

  // === API: GET /api/summary — 获取各渠道统计汇总数据 ===
  if (req.method === 'GET' && pathname === '/api/summary') {
    const records = readDB();
    const stats = getStats(records);
    return json({ ok: true, data: stats.rows, total: stats.total });
  }

  // 静态文件服务（图片、CSS、JS 等）
  const filePath = path.join(__dirname, pathname);
  if (req.method === 'GET' && filePath.startsWith(__dirname)) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
      '.webp':'image/webp','.bmp':'image/bmp','.ico':'image/x-icon',
      '.svg':'image/svg+xml','.css':'text/css','.js':'application/javascript',
      '.json':'application/json','.html':'text/html','.txt':'text/plain'
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
      if (err) return json({ ok: false, error: 'Not Found' }, 404);
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      res.end(data);
    });
    return;
  }

  json({ ok: false, error: 'Not Found' }, 404);
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✅ 订单利润统计已启动！`);
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  📁  数据: ${DB_PATH}`);
  console.log(`  ❌  Ctrl+C 停止\n`);
});
