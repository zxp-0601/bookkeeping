const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 18765;
const DB_PATH = path.join(__dirname, 'records.json');
const INDEX_PATH = path.join(__dirname, 'index.html');

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch(e) { return []; }
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

if (!fs.existsSync(DB_PATH)) {
  writeDB([]);
  console.log(`  📄  初始化数据文件: ${DB_PATH}`);
}

function nextId(records) {
  return records.length > 0 ? Math.max(...records.map(r => r.id)) + 1 : 1;
}

function calcSplit(sales, cost, shipping, service) {
  const beforeSplit = sales - cost - shipping - service;
  return beforeSplit / 2;
}

function calcProfit(r) {
  return calcSplit(r.sales_amount, r.cost, r.shipping_fee, r.service_fee);
}

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/index.html';
  const params = url.searchParams;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  function json(data, status=200) {
    const body = JSON.stringify(data);
    res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function readBody() {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
  }

  if (req.method === 'GET' && (pathname === '/index.html' || pathname === '/')) {
    fs.readFile(INDEX_PATH, (err, data) => {
      if (err) { res.writeHead(500); return res.end('Internal Error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // GET /api/records — with filtering
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

  // POST /api/records — create
  if (req.method === 'POST' && pathname === '/api/records') {
    readBody().then(d => {
      const qty = parseInt(d.quantity) || 1;
      const sales = parseFloat(d.sales_amount) || 0;
      const cost = parseFloat(d.cost) || 0;
      const shipping = parseFloat(d.shipping_fee) || 0;
      const service = parseFloat(d.service_fee) || 0;
      if (sales <= 0) return json({ ok: false, error: '请输入销售额' }, 400);
      if (qty <= 0) return json({ ok: false, error: '数量必须大于0' }, 400);
      const coop = calcSplit(sales, cost, shipping, service);
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

  // PUT /api/records?id=xx — update
  if (req.method === 'PUT' && pathname === '/api/records') {
    readBody().then(d => {
      const id = parseInt(params.get('id'));
      if (!id) return json({ ok: false, error: '请指定ID' }, 400);
      let records = readDB();
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
      record.cooperation_fee = calcSplit(record.sales_amount, record.cost, record.shipping_fee, record.service_fee);
      records[idx] = record;
      writeDB(records);
      json({ ok: true, data: { id: record.id, profit: calcProfit(record), cooperation_fee: record.cooperation_fee } });
    }).catch(() => json({ ok: false, error: '请求格式错误' }, 400));
    return;
  }

  // POST /api/records/batch — import
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
        const coop = calcSplit(sales, cost, shipping, service);
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

  // DELETE /api/records?id=xx
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

  // GET /api/summary
  if (req.method === 'GET' && pathname === '/api/summary') {
    const records = readDB();
    const stats = getStats(records);
    return json({ ok: true, data: stats.rows, total: stats.total });
  }

  // Static file serving
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ✅ 订单利润统计已启动！`);
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  📁  数据: ${DB_PATH}`);
  console.log(`  ❌  Ctrl+C 停止\n`);
});
