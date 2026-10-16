const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function initDB() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'techashi2'
  });

  console.log('Connected to MySQL database "techashi2" on 127.0.0.1:3306');

  // 1. Admins Table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 2. Products Table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(50) NOT NULL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      category VARCHAR(40) NOT NULL,
      description VARCHAR(700) NOT NULL,
      price DECIMAL(12,2) NOT NULL,
      offer_price DECIMAL(12,2) NULL DEFAULT NULL,
      specs JSON NOT NULL,
      sku VARCHAR(40) NOT NULL DEFAULT '',
      stock INT UNSIGNED NULL,
      images JSON NOT NULL,
      is_published TINYINT(1) NOT NULL DEFAULT 1,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX products_category_public (category, is_published, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 3. Orders Table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id CHAR(36) NOT NULL PRIMARY KEY,
      order_number VARCHAR(24) NOT NULL UNIQUE,
      idempotency_key CHAR(36) NOT NULL UNIQUE,
      customer_name VARCHAR(120) NOT NULL,
      customer_email VARCHAR(254) NOT NULL,
      customer_phone VARCHAR(40) NOT NULL,
      fulfillment VARCHAR(16) NOT NULL,
      delivery_address VARCHAR(500) NULL,
      payment_method VARCHAR(32) NOT NULL DEFAULT 'arranged_with_store',
      payment_status VARCHAR(16) NOT NULL DEFAULT 'unpaid',
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      subtotal DECIMAL(12,2) NOT NULL,
      delivery_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL,
      customer_notes VARCHAR(1000) NULL,
      inventory_reserved TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 4. Order Items Table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      order_id CHAR(36) NOT NULL,
      product_id VARCHAR(50) NULL,
      product_name VARCHAR(100) NOT NULL,
      category VARCHAR(40) NOT NULL,
      sku VARCHAR(40) NOT NULL DEFAULT '',
      image_src VARCHAR(1000) NULL,
      unit_price DECIMAL(12,2) NOT NULL,
      quantity INT UNSIGNED NOT NULL,
      INDEX order_items_order (order_id),
      CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // 5. Inquiries / Leads Table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id VARCHAR(50) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      email VARCHAR(254) NULL,
      service VARCHAR(100) NOT NULL,
      message TEXT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'New',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Seed Admins
  const admins = JSON.parse(fs.readFileSync(path.join(__dirname, 'admins.json'), 'utf8'));
  for (const admin of admins) {
    await conn.query(
      'INSERT INTO admins (id, email, password) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE password=VALUES(password)',
      [admin.id, admin.email, admin.password]
    );
  }

  // Seed Products
  const products = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));
  for (const p of products) {
    await conn.query(
      'INSERT INTO products (id, name, category, description, price, offer_price, specs, sku, stock, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), category=VALUES(category), description=VALUES(description), price=VALUES(price), offer_price=VALUES(offer_price), specs=VALUES(specs), sku=VALUES(sku), stock=VALUES(stock), images=VALUES(images)',
      [
        p.id,
        p.name,
        p.category,
        p.description || '',
        p.price,
        p.offer_price || null,
        JSON.stringify(p.specs || []),
        p.sku || '',
        p.stock != null ? p.stock : null,
        JSON.stringify(p.images || [])
      ]
    );
  }

  // Seed Orders
  const orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'orders.json'), 'utf8'));
  for (const o of orders) {
    await conn.query(
      'INSERT INTO orders (id, order_number, idempotency_key, customer_name, customer_email, customer_phone, fulfillment, delivery_address, payment_method, payment_status, status, subtotal, delivery_fee, total, customer_notes, inventory_reserved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status), payment_status=VALUES(payment_status)',
      [
        o.id,
        o.order_number,
        o.idempotency_key,
        o.customer_name,
        o.customer_email,
        o.customer_phone,
        o.fulfillment,
        o.delivery_address || null,
        o.payment_method || 'arranged_with_store',
        o.payment_status || 'unpaid',
        o.status || 'pending',
        o.subtotal,
        o.delivery_fee || 0,
        o.total,
        o.customer_notes || null,
        o.inventory_reserved != null ? o.inventory_reserved : 1
      ]
    );
    if (o.items && o.items.length) {
      for (const item of o.items) {
        await conn.query(
          'INSERT INTO order_items (order_id, product_id, product_name, category, sku, image_src, unit_price, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            o.id,
            item.product_id,
            item.product_name,
            item.category || '',
            item.sku || '',
            item.image_src || null,
            item.unit_price,
            item.quantity
          ]
        );
      }
    }
  }

  // Seed Inquiries
  const inquiries = JSON.parse(fs.readFileSync(path.join(__dirname, 'inquiries.json'), 'utf8'));
  for (const inq of inquiries) {
    await conn.query(
      'INSERT INTO inquiries (id, name, phone, email, service, message, status) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status)',
      [inq.id, inq.name, inq.phone, inq.email || null, inq.service, inq.message || null, inq.status || 'New']
    );
  }

  const [tables] = await conn.query('SHOW TABLES');
  console.log('✅ Success! Tables initialized in phpMyAdmin database "techashi2":', tables.map(t => Object.values(t)[0]));
  await conn.end();
}

initDB().catch(console.error);
