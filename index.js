const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

// Load environment variables from .env file if present
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const firstEq = line.indexOf('=');
        if (firstEq > -1) {
          const key = line.substring(0, firstEq).trim();
          let val = line.substring(firstEq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    });
  }
}
loadEnv();

let PORT = parseInt(process.env.PORT, 10) || 5000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

// Database Connection to phpMyAdmin database "techashi2"
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'techashi2',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

let dbPool = null;
try {
  dbPool = mysql.createPool(dbConfig);
  console.log(`[Database] Connected to MySQL database "${dbConfig.database}" at ${dbConfig.host}:${dbConfig.port}`);
} catch (err) {
  console.error('[Database] MySQL Pool initialization error:', err.message);
}

// Nodemailer SMTP Transporter setup
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  try {
    mailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    console.log(`[Email] SMTP transporter configured for ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
  } catch (err) {
    console.error('[Email] Failed to initialize nodemailer transporter:', err.message);
  }
} else {
  console.log('[Email] SMTP credentials not provided in .env (Emails will be logged to console and saved in DB)');
}

async function sendMailNotification({ to, subject, html, text }) {
  const from = process.env.SMTP_FROM || 'Techashi Solutions Ltd <info@techashisolutions.com>';
  if (mailTransporter) {
    try {
      const info = await mailTransporter.sendMail({ from, to, subject, html, text });
      console.log(`[Email] Sent successfully to ${to} (MessageId: ${info.messageId})`);
      return true;
    } catch (err) {
      console.error(`[Email] Failed to send email to ${to}:`, err.message);
      return false;
    }
  } else {
    console.log(`================== [EMAIL NOTIFICATION] ==================`);
    console.log(` To:      ${to}`);
    console.log(` Subject: ${subject}`);
    console.log(` Body:    ${text || html.replace(/<[^>]+>/g, ' ').slice(0, 300)}...`);
    console.log(`==========================================================`);
    return false;
  }
}

// In-memory active sessions
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies.techashi_admin_sid || req.headers['x-admin-token'];
  if (token && sessions.has(token)) {
    return { token, ...sessions.get(token) };
  }
  return null;
}

function readJSON(file, fallback = []) {
  try {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) return fallback;
    const data = fs.readFileSync(fullPath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Error reading JSON from', file, e);
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(path.join(__dirname, file), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error writing to file:', file, e);
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', err => reject(err));
  });
}

function sendJSON(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true',
  });
  res.end(JSON.stringify(payload));
}

function createServer(port) {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${port}`);
    const pathname = parsedUrl.pathname;
    const queryRoute = parsedUrl.searchParams.get('route') || '';

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Admin-Token, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // --- STATIC UPLOADS SERVING ---
    if (pathname.startsWith('/uploads/products/')) {
      const fileName = path.basename(pathname);
      const filePath = path.join(__dirname, 'uploads', 'products', fileName);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    // Determine API route (supports /api/... or /api/index.php?route=...)
    const isApi = pathname.startsWith('/api') || queryRoute !== '';
    let apiEndpoint = '';
    if (queryRoute) {
      apiEndpoint = queryRoute;
    } else if (pathname.startsWith('/api/')) {
      apiEndpoint = pathname.replace('/api/', '').split('/')[0];
    }

    if (isApi && apiEndpoint) {
      // 1. SESSION / CSRF
      if (apiEndpoint === 'session' && req.method === 'GET') {
        const currentSession = getSession(req);
        let csrfToken = currentSession?.csrfToken;
        if (!csrfToken) {
          csrfToken = crypto.randomBytes(16).toString('hex');
        }
        return sendJSON(res, 200, {
          user: currentSession?.user || null,
          csrfToken: csrfToken,
        });
      }

      // 2. ADMIN LOGIN
      if (apiEndpoint === 'login' && req.method === 'POST') {
        const body = await parseBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        let matched = null;
        if (dbPool) {
          try {
            const [rows] = await dbPool.query('SELECT id, email, password FROM admins WHERE email = ? LIMIT 1', [email]);
            if (rows.length && rows[0].password === password) {
              matched = rows[0];
            }
          } catch (e) {
            console.warn('[Database] MySQL login query fallback:', e.message);
          }
        }

        if (!matched) {
          const admins = readJSON('admins.json', []);
          matched = admins.find(a => a.email.toLowerCase() === email && a.password === password);
        }

        if (!matched) {
          return sendJSON(res, 401, { error: 'Email or password is incorrect.' });
        }

        const sid = generateToken();
        const csrfToken = crypto.randomBytes(16).toString('hex');
        const userObj = { id: matched.id, email: matched.email };

        sessions.set(sid, {
          user: userObj,
          csrfToken: csrfToken,
          createdAt: Date.now(),
        });

        res.setHeader('Set-Cookie', `techashi_admin_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
        return sendJSON(res, 200, {
          user: userObj,
          csrfToken: csrfToken,
          token: sid,
        });
      }

      // 3. ADMIN LOGOUT
      if (apiEndpoint === 'logout' && req.method === 'POST') {
        const cookies = parseCookies(req);
        if (cookies.techashi_admin_sid) {
          sessions.delete(cookies.techashi_admin_sid);
        }
        res.setHeader('Set-Cookie', `techashi_admin_sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
        return sendJSON(res, 200, { ok: true });
      }

      // 4. ADMIN ACCOUNT CREATION
      if (apiEndpoint === 'admins' && req.method === 'POST') {
        const body = await parseBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!email || !email.includes('@')) {
          return sendJSON(res, 422, { error: 'Enter a valid email address.' });
        }
        if (password.length < 12 || password.length > 200) {
          return sendJSON(res, 422, { error: 'Use a password between 12 and 200 characters.' });
        }

        let newAdminId = null;
        if (dbPool) {
          try {
            const [existing] = await dbPool.query('SELECT id FROM admins WHERE email = ? LIMIT 1', [email]);
            if (existing.length) {
              return sendJSON(res, 409, { error: 'An administrator already exists with that email.' });
            }
            const [result] = await dbPool.query('INSERT INTO admins (email, password) VALUES (?, ?)', [email, password]);
            newAdminId = result.insertId;
          } catch (e) {
            console.warn('[Database] MySQL admin insert fallback:', e.message);
          }
        }

        const admins = readJSON('admins.json', []);
        if (admins.some(a => a.email.toLowerCase() === email)) {
          return sendJSON(res, 409, { error: 'An administrator already exists with that email.' });
        }

        const newAdmin = {
          id: newAdminId || (admins.length ? Math.max(...admins.map(a => a.id)) + 1 : 1),
          email,
          password,
          created_at: new Date().toISOString(),
        };
        admins.push(newAdmin);
        writeJSON('admins.json', admins);

        return sendJSON(res, 201, { ok: true, email });
      }

      // 5. PRODUCTS CRUD
      if (apiEndpoint === 'products') {
        if (req.method === 'GET') {
          const cat = parsedUrl.searchParams.get('category');
          const id = parsedUrl.searchParams.get('id');

          if (dbPool) {
            try {
              if (id) {
                const [rows] = await dbPool.query('SELECT * FROM products WHERE id = ? LIMIT 1', [id]);
                if (rows.length) {
                  const p = rows[0];
                  p.price = Number(p.price);
                  p.offer_price = p.offer_price != null ? Number(p.offer_price) : null;
                  p.specs = typeof p.specs === 'string' ? JSON.parse(p.specs || '[]') : p.specs;
                  p.images = typeof p.images === 'string' ? JSON.parse(p.images || '[]') : p.images;
                  return sendJSON(res, 200, { product: p });
                }
              } else {
                let query = 'SELECT * FROM products WHERE is_published = 1';
                const params = [];
                if (cat && cat !== 'all') {
                  query += ' AND category = ?';
                  params.push(cat);
                }
                query += ' ORDER BY updated_at DESC';
                const [rows] = await dbPool.query(query, params);
                const items = rows.map(p => ({
                  ...p,
                  price: Number(p.price),
                  offer_price: p.offer_price != null ? Number(p.offer_price) : null,
                  specs: typeof p.specs === 'string' ? JSON.parse(p.specs || '[]') : p.specs,
                  images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : p.images,
                }));
                return sendJSON(res, 200, { products: items, total: items.length });
              }
            } catch (e) {
              console.warn('[Database] MySQL products query fallback:', e.message);
            }
          }

          const products = readJSON('products.json', []);
          if (id) {
            const single = products.find(p => String(p.id) === String(id));
            return sendJSON(res, 200, { product: single || null });
          }

          let filtered = products;
          if (cat && cat !== 'all') {
            filtered = products.filter(p => p.category === cat);
          }
          return sendJSON(res, 200, { products: filtered, total: filtered.length });
        }

        if (req.method === 'POST' || req.method === 'PUT') {
          const body = await parseBody(req);
          if (!body.name || !body.price) {
            return sendJSON(res, 422, { error: 'Add a product name, category, price, and specifications.' });
          }

          let id = body.id || (req.method === 'PUT' ? parsedUrl.searchParams.get('id') : null);
          if (!id) {
            id = 'prod-' + Date.now();
          }

          const productItem = {
            id: String(id),
            name: String(body.name || '').trim(),
            category: String(body.category || 'laptops').toLowerCase(),
            description: String(body.description || '').trim(),
            price: Number(body.price),
            offer_price: body.offer_price != null && body.offer_price !== '' ? Number(body.offer_price) : null,
            specs: Array.isArray(body.specs)
              ? body.specs
              : String(body.specs || '').split('\n').map(s => s.trim()).filter(Boolean),
            sku: String(body.sku || '').trim(),
            stock: body.stock != null && body.stock !== '' ? Number(body.stock) : null,
            images: Array.isArray(body.images) ? body.images : [],
            updatedAt: new Date().toISOString(),
          };

          if (dbPool) {
            try {
              await dbPool.query(
                `INSERT INTO products (id, name, category, description, price, offer_price, specs, sku, stock, images)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                 name=VALUES(name), category=VALUES(category), description=VALUES(description), price=VALUES(price),
                 offer_price=VALUES(offer_price), specs=VALUES(specs), sku=VALUES(sku), stock=VALUES(stock), images=VALUES(images)`,
                [
                  productItem.id,
                  productItem.name,
                  productItem.category,
                  productItem.description,
                  productItem.price,
                  productItem.offer_price,
                  JSON.stringify(productItem.specs),
                  productItem.sku,
                  productItem.stock,
                  JSON.stringify(productItem.images),
                ]
              );
            } catch (e) {
              console.warn('[Database] MySQL product save fallback:', e.message);
            }
          }

          const products = readJSON('products.json', []);
          const existingIdx = products.findIndex(p => String(p.id) === String(productItem.id));
          if (existingIdx > -1) {
            products[existingIdx] = { ...products[existingIdx], ...productItem };
          } else {
            products.unshift(productItem);
          }
          writeJSON('products.json', products);

          return sendJSON(res, req.method === 'POST' ? 201 : 200, { ok: true, product: productItem });
        }

        if (req.method === 'DELETE') {
          const id = parsedUrl.searchParams.get('id');

          if (dbPool) {
            try {
              await dbPool.query('DELETE FROM products WHERE id = ?', [id]);
            } catch (e) {
              console.warn('[Database] MySQL product delete fallback:', e.message);
            }
          }

          let products = readJSON('products.json', []);
          products = products.filter(p => String(p.id) !== String(id));
          writeJSON('products.json', products);
          return sendJSON(res, 200, { ok: true, total: products.length });
        }
      }

      // 6. ORDERS MANAGEMENT
      if (apiEndpoint === 'orders') {
        if (req.method === 'GET') {
          if (dbPool) {
            try {
              const [orders] = await dbPool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
              const [allItems] = await dbPool.query('SELECT * FROM order_items ORDER BY id');
              const populated = orders.map(o => ({
                ...o,
                subtotal: Number(o.subtotal),
                total: Number(o.total),
                items: allItems.filter(item => item.order_id === o.id).map(i => ({
                  ...i,
                  unit_price: Number(i.unit_price),
                  quantity: Number(i.quantity)
                }))
              }));
              return sendJSON(res, 200, { orders: populated });
            } catch (e) {
              console.warn('[Database] MySQL orders query fallback:', e.message);
            }
          }

          const orders = readJSON('orders.json', []);
          return sendJSON(res, 200, { orders });
        }

        if (req.method === 'POST') {
          const body = await parseBody(req);
          const customer = body.customer || {};
          const items = body.items || [];
          const fulfillment = body.fulfillment || 'pickup';
          let total = Number(body.total || body.expectedSubtotal || 0);

          if (!total && items.length) {
            total = items.reduce((sum, it) => sum + (Number(it.unitPrice || it.price || 0) * Number(it.quantity || 1)), 0);
          }

          const orderId = crypto.randomUUID();
          const orderNumber = 'TA-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();

          const newOrder = {
            id: orderId,
            order_number: orderNumber,
            idempotency_key: body.idempotencyKey || crypto.randomUUID(),
            customer_name: customer.name || 'Walk-in Customer',
            customer_email: customer.email || 'info@techashisolutions.com',
            customer_phone: customer.phone || '+254 700 357 022',
            fulfillment: fulfillment,
            delivery_address: fulfillment === 'delivery' ? (customer.address || '') : null,
            payment_method: 'arranged_with_store',
            payment_status: 'unpaid',
            status: 'pending',
            subtotal: total,
            delivery_fee: 0,
            total: total,
            customer_notes: customer.notes || null,
            inventory_reserved: 1,
            created_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
          };

          if (dbPool) {
            try {
              await dbPool.query(
                `INSERT INTO orders (id, order_number, idempotency_key, customer_name, customer_email, customer_phone, fulfillment, delivery_address, payment_method, payment_status, status, subtotal, delivery_fee, total, customer_notes, inventory_reserved)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  newOrder.id, newOrder.order_number, newOrder.idempotency_key, newOrder.customer_name,
                  newOrder.customer_email, newOrder.customer_phone, newOrder.fulfillment, newOrder.delivery_address,
                  newOrder.payment_method, newOrder.payment_status, newOrder.status, newOrder.subtotal,
                  newOrder.delivery_fee, newOrder.total, newOrder.customer_notes, newOrder.inventory_reserved
                ]
              );
              for (const item of items) {
                await dbPool.query(
                  `INSERT INTO order_items (order_id, product_id, product_name, category, sku, image_src, unit_price, quantity)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    newOrder.id, item.productId, item.name || 'Product', item.category || '',
                    item.sku || '', item.image_src || null, item.unitPrice || 0, item.quantity || 1
                  ]
                );
              }
            } catch (e) {
              console.warn('[Database] MySQL order save fallback:', e.message);
            }
          }

          const orders = readJSON('orders.json', []);
          const products = readJSON('products.json', []);
          newOrder.items = items.map(item => {
            const prod = products.find(p => String(p.id) === String(item.productId)) || {};
            return {
              product_id: item.productId,
              product_name: prod.name || item.name || 'Product',
              category: prod.category || 'general',
              sku: prod.sku || '',
              image_src: (prod.images && prod.images[0]?.src) || null,
              unit_price: Number(item.unitPrice || prod.offer_price || prod.price || 0),
              quantity: Number(item.quantity || 1),
            };
          });

          orders.unshift(newOrder);
          writeJSON('orders.json', orders);

          // DISPATCH EMAIL NOTIFICATIONS FOR NEW ORDER
          const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'info@techashisolutions.com';
          const itemsSummaryHtml = newOrder.items.map(it => `
            <tr>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0;">${it.product_name} (${it.category})</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">${it.quantity}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: right;">KES ${(it.unit_price * it.quantity).toLocaleString()}</td>
            </tr>
          `).join('');

          // 1. Email to Store Administrator
          sendMailNotification({
            to: adminEmail,
            subject: `🛒 New Customer Order [${newOrder.order_number}] - ${newOrder.customer_name}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <div style="background-color: #075293; padding: 15px 20px; border-radius: 8px; color: white;">
                  <h2 style="margin: 0; font-size: 20px;">New Order Placed - Techashi Solutions</h2>
                  <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Order Ref: <strong>${newOrder.order_number}</strong></p>
                </div>
                <div style="padding: 20px 0;">
                  <p><strong>Customer Name:</strong> ${newOrder.customer_name}</p>
                  <p><strong>Phone:</strong> <a href="tel:${newOrder.customer_phone}">${newOrder.customer_phone}</a></p>
                  <p><strong>Email:</strong> <a href="mailto:${newOrder.customer_email}">${newOrder.customer_email}</a></p>
                  <p><strong>Fulfillment:</strong> ${newOrder.fulfillment === 'delivery' ? `Delivery to: ${newOrder.delivery_address}` : 'Store Collection (Chaka Place)'}</p>
                  ${newOrder.customer_notes ? `<p><strong>Client Notes:</strong> ${newOrder.customer_notes}</p>` : ''}
                  
                  <h4 style="margin: 20px 0 10px; color: #075293;">Ordered Items:</h4>
                  <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead>
                      <tr style="background-color: #f8fafc; text-align: left;">
                        <th style="padding: 8px 12px;">Product</th>
                        <th style="padding: 8px 12px; text-align: center;">Qty</th>
                        <th style="padding: 8px 12px; text-align: right;">Total</th>
                      </tr>
                    </thead>
                    <tbody>${itemsSummaryHtml}</tbody>
                    <tfoot>
                      <tr>
                        <td colspan="2" style="padding: 12px; text-align: right; font-weight: bold;">Grand Total:</td>
                        <td style="padding: 12px; text-align: right; font-weight: bold; font-size: 16px; color: #075293;">KES ${newOrder.total.toLocaleString()}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div style="background: #f1f5f9; padding: 12px; border-radius: 8px; font-size: 12px; text-align: center;">
                  Manage this order in your <a href="http://localhost:5000/admin/orders" style="color: #075293; font-weight: bold;">Techashi Admin Portal</a>.
                </div>
              </div>
            `,
            text: `New order ${newOrder.order_number} from ${newOrder.customer_name} (${newOrder.customer_phone}). Total: KES ${newOrder.total}.`
          });

          // 2. Confirmation to Customer (if valid email provided)
          if (newOrder.customer_email && newOrder.customer_email.includes('@') && !newOrder.customer_email.includes('techashisolutions.com')) {
            sendMailNotification({
              to: newOrder.customer_email,
              subject: `Order Confirmation [${newOrder.order_number}] - Techashi Solutions Ltd`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                  <h2 style="color: #075293; margin-top: 0;">Thank you for your order, ${newOrder.customer_name}!</h2>
                  <p>We have received your order <strong>${newOrder.order_number}</strong>. Our equipment specialist will contact you shortly to confirm dispatch and delivery.</p>
                  <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 15px 0;">
                    <tbody>${itemsSummaryHtml}</tbody>
                    <tfoot>
                      <tr>
                        <td colspan="2" style="padding: 10px 12px; text-align: right; font-weight: bold;">Total:</td>
                        <td style="padding: 10px 12px; text-align: right; font-weight: bold; color: #075293;">KES ${newOrder.total.toLocaleString()}</td>
                      </tr>
                    </tfoot>
                  </table>
                  <p style="font-size: 13px; color: #64748b;">
                    Need immediate assistance? Contact us at <strong>+254 700 357 022</strong> or visit us at Chaka Place Building, 3rd Floor, Argwings Kodhek Rd, Nairobi.
                  </p>
                </div>
              `,
              text: `Thank you for your order ${newOrder.order_number} with Techashi Solutions Ltd. Total: KES ${newOrder.total}. We will contact you shortly.`
            });
          }

          return sendJSON(res, 201, { ok: true, order: { orderNumber, total, status: 'pending' } });
        }

        if (req.method === 'PATCH') {
          const id = parsedUrl.searchParams.get('id');
          const body = await parseBody(req);

          if (dbPool) {
            try {
              if (body.status && body.paymentStatus) {
                await dbPool.query('UPDATE orders SET status = ?, payment_status = ? WHERE id = ?', [body.status, body.paymentStatus, id]);
              } else if (body.status) {
                await dbPool.query('UPDATE orders SET status = ? WHERE id = ?', [body.status, id]);
              } else if (body.paymentStatus) {
                await dbPool.query('UPDATE orders SET payment_status = ? WHERE id = ?', [body.paymentStatus, id]);
              }
            } catch (e) {
              console.warn('[Database] MySQL order patch fallback:', e.message);
            }
          }

          const orders = readJSON('orders.json', []);
          const order = orders.find(o => String(o.id) === String(id));
          if (order) {
            if (body.status) order.status = body.status;
            if (body.paymentStatus) order.payment_status = body.paymentStatus;
            order.updated_at = new Date().toISOString().replace('T', ' ').substring(0, 19);
            writeJSON('orders.json', orders);
          }
          return sendJSON(res, 200, { ok: true });
        }
      }

      // 7. IMAGE UPLOAD
      if (apiEndpoint === 'upload' && req.method === 'POST') {
        const body = await parseBody(req);
        const imagesList = [];

        const incoming = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
        const uploadDir = path.join(__dirname, 'uploads', 'products');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        for (const item of incoming) {
          if (typeof item === 'string' && item.startsWith('data:image')) {
            const matches = item.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
            if (matches) {
              const ext = matches[1].replace('jpeg', 'jpg');
              const buffer = Buffer.from(matches[2], 'base64');
              const fileName = crypto.randomBytes(18).toString('hex') + '.' + ext;
              fs.writeFileSync(path.join(uploadDir, fileName), buffer);
              imagesList.push({
                src: `/uploads/products/${fileName}`,
                path: fileName,
                name: fileName,
              });
            }
          } else if (item.data && item.name) {
            const ext = path.extname(item.name).replace('.', '') || 'jpg';
            const buffer = Buffer.from(item.data, 'base64');
            const fileName = crypto.randomBytes(18).toString('hex') + '.' + ext;
            fs.writeFileSync(path.join(uploadDir, fileName), buffer);
            imagesList.push({
              src: `/uploads/products/${fileName}`,
              path: fileName,
              name: item.name,
            });
          }
        }

        return sendJSON(res, 201, { images: imagesList });
      }

      // 8. INQUIRIES & LEADS (WITH EMAIL ALERTS)
      if (apiEndpoint === 'inquiries') {
        if (req.method === 'GET') {
          if (dbPool) {
            try {
              const [rows] = await dbPool.query('SELECT * FROM inquiries ORDER BY created_at DESC');
              const mapped = rows.map(r => ({
                id: r.id,
                name: r.name,
                phone: r.phone,
                email: r.email || '',
                service: r.service,
                message: r.message || '',
                status: r.status,
                date: new Date(r.created_at).toISOString().replace('T', ' ').substring(0, 16)
              }));
              return sendJSON(res, 200, mapped);
            } catch (e) {
              console.warn('[Database] MySQL inquiries query fallback:', e.message);
            }
          }

          const inquiries = readJSON('inquiries.json', []);
          return sendJSON(res, 200, inquiries);
        }

        if (req.method === 'POST') {
          const lead = await parseBody(req);
          const newLead = {
            id: 'inq-' + Date.now(),
            name: lead.name || 'Anonymous',
            phone: lead.phone || '',
            email: lead.email || '',
            service: lead.service || 'General Inquiry',
            message: lead.message || '',
            status: 'New',
            date: new Date().toISOString().replace('T', ' ').substring(0, 16),
          };

          if (dbPool) {
            try {
              await dbPool.query(
                'INSERT INTO inquiries (id, name, phone, email, service, message, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [newLead.id, newLead.name, newLead.phone, newLead.email || null, newLead.service, newLead.message || null, newLead.status]
              );
            } catch (e) {
              console.warn('[Database] MySQL inquiry insert fallback:', e.message);
            }
          }

          let inquiries = readJSON('inquiries.json', []);
          inquiries.unshift(newLead);
          writeJSON('inquiries.json', inquiries);

          // DISPATCH EMAIL ALERTS FOR NEW LEAD
          const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'info@techashisolutions.com';
          const cleanPhone = (newLead.phone || '').replace(/[^0-9]/g, '');
          const waPhone = cleanPhone.startsWith('254') ? cleanPhone : '254' + cleanPhone.replace(/^0/, '');
          const waLink = `https://wa.me/${waPhone}?text=${encodeURIComponent(`Hi ${newLead.name}, thank you for contacting Techashi Solutions regarding ${newLead.service}.`)}`;

          // 1. Email notification to Administrator
          sendMailNotification({
            to: adminEmail,
            subject: `🔔 New Website Lead: ${newLead.name} - ${newLead.service}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <div style="background-color: #075293; padding: 15px 20px; border-radius: 8px; color: white;">
                  <h2 style="margin: 0; font-size: 20px;">New Quote Request / Inquiry</h2>
                  <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Techashi Solutions Lead Notification</p>
                </div>
                <div style="padding: 20px 0; font-size: 14px; line-height: 1.6;">
                  <p><strong>Client Name:</strong> ${newLead.name}</p>
                  <p><strong>Phone:</strong> <a href="tel:${newLead.phone}">${newLead.phone}</a></p>
                  <p><strong>Email:</strong> ${newLead.email ? `<a href="mailto:${newLead.email}">${newLead.email}</a>` : 'Not provided'}</p>
                  <p><strong>Service / Requirement:</strong> <span style="background: #e0f2fe; color: #0369a1; padding: 3px 8px; border-radius: 6px; font-weight: bold;">${newLead.service}</span></p>
                  <p><strong>Message / Notes:</strong></p>
                  <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border-left: 4px solid #075293;">
                    ${newLead.message || 'No additional message provided.'}
                  </div>
                  <div style="margin-top: 20px;">
                    <a href="${waLink}" style="display: inline-block; background-color: #25D366; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 13px;">
                      Reply on WhatsApp (${newLead.phone})
                    </a>
                  </div>
                </div>
                <div style="background: #f1f5f9; padding: 12px; border-radius: 8px; font-size: 12px; text-align: center; color: #64748b;">
                  View this and all leads in your <a href="http://localhost:5000/admin/inquiries" style="color: #075293; font-weight: bold;">Admin Inquiries Desk</a>.
                </div>
              </div>
            `,
            text: `New lead: ${newLead.name} (${newLead.phone}, ${newLead.email}). Service: ${newLead.service}. Message: ${newLead.message}`
          });

          // 2. Auto-reply to customer (if email provided)
          if (newLead.email && newLead.email.includes('@')) {
            sendMailNotification({
              to: newLead.email,
              subject: `Thank you for contacting Techashi Solutions Ltd`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                  <h2 style="color: #075293; margin-top: 0;">Hi ${newLead.name},</h2>
                  <p>Thank you for reaching out to <strong>Techashi Solutions Ltd</strong> regarding <strong>${newLead.service}</strong>.</p>
                  <p>Our technology team has received your request and an engineer or specialist will review your requirements and get in touch with you shortly.</p>
                  <div style="margin: 20px 0; padding: 15px; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 13px;">
                    <p style="margin: 0 0 5px;"><strong>Need urgent assistance?</strong></p>
                    <p style="margin: 0;">Call or WhatsApp us directly at: <a href="tel:+254700357022" style="color: #075293; font-weight: bold;">+254 700 357 022</a></p>
                    <p style="margin: 5px 0 0;">Office: Chaka Place Building, 3rd Floor, Argwings Kodhek Rd, Nairobi, Kenya</p>
                  </div>
                  <p style="font-size: 12px; color: #94a3b8;">Techashi Solutions Ltd · Technology that keeps your business moving.</p>
                </div>
              `,
              text: `Hi ${newLead.name}, thank you for contacting Techashi Solutions Ltd regarding ${newLead.service}. Our team will contact you shortly. Need urgent assistance? Call +254 700 357 022.`
            });
          }

          return sendJSON(res, 200, { success: true, lead: newLead });
        }
      }
    }

    // --- FRIENDLY ROUTING FOR PAGES ---
    let targetFile = pathname;
    if (pathname === '/' || pathname === '') {
      targetFile = '/index.html';
    } else if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      targetFile = '/admin.html';
    } else if (pathname === '/company-profile' || pathname === '/profile') {
      targetFile = '/company-profile.html';
    } else if (pathname === '/products' || pathname === '/catalog' || pathname === '/equipment') {
      targetFile = '/products.html';
    } else if (pathname === '/cart' || pathname === '/bag' || pathname === '/checkout') {
      targetFile = '/cart.html';
    }

    const filePath = path.join(__dirname, targetFile);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          if (pathname.startsWith('/admin')) {
            const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(adminHtml);
            return;
          }
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>404 Not Found - Techashi Solutions</h1>', 'utf-8');
        } else {
          res.writeHead(500);
          res.end(`Server Error: ${err.code}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} is in use, trying port ${port + 1}...`);
      createServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`===============================================`);
    console.log(` Techashi Solutions LIVE with MySQL & Email Engine:`);
    console.log(` Database:        ${dbConfig.database} (127.0.0.1:3306)`);
    console.log(` phpMyAdmin:      http://localhost/phpmyadmin/index.php?route=/database/structure&db=techashi2`);
    console.log(` Admin Notify:    ${process.env.ADMIN_NOTIFY_EMAIL || 'info@techashisolutions.com'}`);
    console.log(` Website:         ${url}`);
    console.log(` Admin Portal:    ${url}/admin`);
    console.log(`===============================================`);
  });
}

createServer(PORT);
