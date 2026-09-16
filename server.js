import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const database = new Database(process.env.DATABASE_FILE || path.join(__dirname, 'salon.db'));
const sessionDays = Number(process.env.SESSION_DAYS || 7);

if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'change-this-before-starting') {
  throw new Error('Set ADMIN_EMAIL and a strong ADMIN_PASSWORD in .env before starting the server.');
}

const schema = database.transaction(() => {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('client', 'admin')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(category_id, name)
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      location TEXT,
      service_id INTEGER NOT NULL REFERENCES services(id),
      appointment_date TEXT NOT NULL,
      appointment_time TEXT NOT NULL DEFAULT '09:00',
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Confirmed', 'Completed', 'Cancelled')),
      email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sent', 'failed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS contact_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
})();
schema();

database.prepare('INSERT OR IGNORE INTO promotions (id, title, description, action, enabled) VALUES (1, ?, ?, ?, 1)').run('Seasonal glow package', 'Save 20% on a complete hair + skin refresh with our curated beauty bundle.', 'Claim offer');
database.prepare('INSERT OR IGNORE INTO contact_settings (id, name, email, phone, whatsapp) VALUES (1, ?, ?, ?, ?)').run('Thuli', 'ncoyanokuthula25@gmail.com', '074 934 6303', '27749346303');

function ensureColumn(table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('bookings', 'appointment_time', "TEXT NOT NULL DEFAULT '09:00'");
ensureColumn('bookings', 'email_status', "TEXT NOT NULL DEFAULT 'pending'");

if (database.prepare('SELECT COUNT(*) AS count FROM categories').get().count === 0) {
  const seed = database.transaction(() => {
    const insertCategory = database.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    const insertService = database.prepare('INSERT INTO services (category_id, name, price, duration_minutes) VALUES (?, ?, ?, ?)');
    const categories = [
      ['Hair', [['Hair Design', 'R80', 60], ['Signature Package', 'R320', 120]]],
      ['Skin', [['Skin Renewal', 'R110', 60]]],
      ['Nails', [['Beauty Rituals', 'R65', 45]]]
    ];
    categories.forEach(([name, services], index) => {
      const category = insertCategory.run(name, index);
      services.forEach(([serviceName, price, duration]) => insertService.run(category.lastInsertRowid, serviceName, price, duration));
    });
  });
  seed();
}

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(__dirname, { extensions: ['html'] }));
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  next();
});
setInterval(() => database.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(), 60 * 60 * 1000).unref();

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, message: { error: 'Too many authentication attempts.' } });
const emailSchema = z.string().email().max(254).transform((value) => value.toLowerCase());
const serviceSchema = z.object({ name: z.string().trim().min(1).max(80), price: z.string().trim().min(1).max(30), durationMinutes: z.number().int().min(15).max(480), enabled: z.boolean() });
const categorySchema = z.object({ name: z.string().trim().min(1).max(80), enabled: z.boolean(), services: z.array(serviceSchema).min(1) });
const bookingSchema = z.object({ name: z.string().trim().min(2).max(100), email: emailSchema, phone: z.string().trim().min(5).max(30), location: z.string().trim().max(250).optional().default(''), serviceId: z.number().int().positive(), appointmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), appointmentTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), notes: z.string().trim().max(1000).optional().default('') });
const commentSchema = z.object({ name: z.string().trim().min(2).max(100), rating: z.number().int().min(1).max(5), message: z.string().trim().min(3).max(500) });
const bannedLanguage = /\b(fuck|fucking|shit|bitch|asshole|bastard|damn)\b/i;

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function setSessionCookie(res, token, maxAge) {
  const flags = [`salon_session=${token}`, `Max-Age=${Math.floor(maxAge / 1000)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isProduction) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
function createSession(userId, res) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + sessionDays * 86400000).toISOString();
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(rawToken), userId, expires);
  setSessionCookie(res, rawToken, sessionDays * 86400000);
}
function currentUser(req) {
  const token = req.headers.cookie?.match(/(?:^|; )salon_session=([^;]+)/)?.[1];
  if (!token) return null;
  const user = database.prepare(`SELECT users.id, users.email, users.role FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')`).get(hashToken(token));
  if (user?.role === 'admin') user.username = process.env.ADMIN_USERNAME || user.email;
  return user;
}
function requireAuth(role) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user || (role && user.role !== role)) return res.status(401).json({ error: 'Authentication required.' });
    req.user = user;
    next();
  };
}
function sendBookingEmail(booking) {
  if (!process.env.SMTP_HOST) return Promise.resolve(false);
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } });
  const recipient = database.prepare('SELECT email FROM contact_settings WHERE id = 1').get()?.email || process.env.HAIRDRESSER_EMAIL;
  return transporter.sendMail({ from: process.env.MAIL_FROM, to: recipient, subject: `New booking request from ${booking.name}`, text: JSON.stringify(booking, null, 2) }).then(() => true);
}

function isSalonSlot(time) {
  const [hour, minute] = time.split(':').map(Number);
  const totalMinutes = hour * 60 + minute;
  return totalMinutes >= 9 * 60 && totalMinutes <= 18 * 60 && minute % 30 === 0;
}

app.post('/api/auth/register', authLimit, async (req, res) => {
  const parsed = z.object({ email: emailSchema, password: z.string().min(8).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Use a valid email and password of at least 8 characters.' });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  try {
    const result = database.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)').run(parsed.data.email, passwordHash, 'client');
    createSession(result.lastInsertRowid, res);
    res.status(201).json({ email: parsed.data.email, role: 'client' });
  } catch { res.status(409).json({ error: 'An account with that email already exists.' }); }
});

app.post('/api/auth/login', authLimit, async (req, res) => {
  const parsed = z.object({ identifier: z.string().trim().min(1).max(254).optional(), email: emailSchema.optional(), password: z.string().max(128) }).refine((value) => value.identifier || value.email).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid credentials.' });
  const identifier = parsed.data.identifier || parsed.data.email;
  const adminEmail = process.env.ADMIN_EMAIL.toLowerCase();
  const adminUsername = (process.env.ADMIN_USERNAME || '').toLowerCase();
  const loginEmail = identifier.toLowerCase() === adminUsername ? adminEmail : identifier.toLowerCase();
  let user = database.prepare('SELECT * FROM users WHERE email = ?').get(loginEmail);
  if (!user && loginEmail === adminEmail) {
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    const result = database.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)').run(adminEmail, passwordHash, 'admin');
    user = { id: result.lastInsertRowid, email: adminEmail, role: 'admin', password_hash: passwordHash };
  }
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) return res.status(401).json({ error: 'Invalid credentials.' });
  createSession(user.id, res);
  res.json({ email: user.email, username: user.role === 'admin' ? (process.env.ADMIN_USERNAME || user.email) : undefined, role: user.role });
});

app.post('/api/auth/logout', (req, res) => { res.setHeader('Set-Cookie', 'salon_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'); res.status(204).end(); });
app.get('/api/auth/me', requireAuth(), (req, res) => res.json(req.user));

app.put('/api/admin/account', requireAuth('admin'), async (req, res) => {
  const parsed = z.object({ currentPassword: z.string().min(8).max(128), email: emailSchema, newPassword: z.string().min(8).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and passwords of at least 8 characters.' });
  const user = database.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.user.id, 'admin');
  if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.password_hash))) return res.status(401).json({ error: 'Current password is incorrect.' });
  const conflict = database.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(parsed.data.email, user.id);
  if (conflict) return res.status(409).json({ error: 'That email is already in use.' });
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  database.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?').run(parsed.data.email, passwordHash, user.id);
  database.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  createSession(user.id, res);
  res.json({ email: parsed.data.email, role: 'admin' });
});

app.get('/api/services', (req, res) => {
  const categories = database.prepare('SELECT * FROM categories WHERE enabled = 1 ORDER BY sort_order, id').all().map((category) => ({ id: category.id, name: category.name, enabled: Boolean(category.enabled), services: database.prepare('SELECT id, name, price, duration_minutes AS durationMinutes, enabled FROM services WHERE category_id = ? AND enabled = 1 ORDER BY id').all(category.id).map((service) => ({ ...service, enabled: Boolean(service.enabled) })) }));
  res.json(categories);
});

app.get('/api/promotions', (req, res) => {
  const promotion = database.prepare('SELECT title, description, action, enabled FROM promotions WHERE id = 1').get();
  res.json({ ...promotion, enabled: Boolean(promotion?.enabled) });
});

app.get('/api/contact', (req, res) => res.json(database.prepare('SELECT name, email, phone, whatsapp FROM contact_settings WHERE id = 1').get()));

app.put('/api/admin/contact', requireAuth('admin'), (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(80), email: emailSchema, phone: z.string().trim().min(5).max(30), whatsapp: z.string().regex(/^\d{8,15}$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid name, email, phone, and WhatsApp number.' });
  database.prepare('UPDATE contact_settings SET name = ?, email = ?, phone = ?, whatsapp = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(parsed.data.name, parsed.data.email, parsed.data.phone, parsed.data.whatsapp);
  res.json(parsed.data);
});

app.put('/api/admin/promotions', requireAuth('admin'), (req, res) => {
  const parsed = z.object({ title: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(300), action: z.string().trim().min(1).max(30), enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Complete every promotion field.' });
  database.prepare('UPDATE promotions SET title = ?, description = ?, action = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(parsed.data.title, parsed.data.description, parsed.data.action, parsed.data.enabled ? 1 : 0);
  res.json(parsed.data);
});

app.put('/api/admin/services', requireAuth('admin'), (req, res) => {
  const parsed = z.object({ categories: z.array(categorySchema).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Every category needs a name and at least one valid service.' });
  const save = database.transaction((categories) => {
    const existingCategories = database.prepare('SELECT id, name FROM categories').all();
    const existingByName = new Map(existingCategories.map((category) => [category.name.toLowerCase(), category]));
    const touchedCategoryIds = [];
    const upsertCategory = database.prepare('INSERT INTO categories (name, sort_order, enabled) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order, enabled = excluded.enabled');
    const updateCategory = database.prepare('SELECT id FROM categories WHERE name = ?');
    const upsertService = database.prepare('INSERT INTO services (category_id, name, price, duration_minutes, enabled) VALUES (?, ?, ?, ?, ?) ON CONFLICT(category_id, name) DO UPDATE SET price = excluded.price, duration_minutes = excluded.duration_minutes, enabled = excluded.enabled');
    const updateService = database.prepare('SELECT id FROM services WHERE category_id = ? AND name = ?');
    const disableCategory = database.prepare('UPDATE categories SET enabled = 0 WHERE id = ?');
    const disableServices = database.prepare('UPDATE services SET enabled = 0 WHERE category_id = ?');
    categories.forEach((category, index) => {
      upsertCategory.run(category.name, index, category.enabled ? 1 : 0);
      const categoryId = updateCategory.get(category.name).id;
      touchedCategoryIds.push(categoryId);
      const touchedServiceIds = [];
      category.services.forEach((service) => {
        upsertService.run(categoryId, service.name, service.price, service.durationMinutes, service.enabled ? 1 : 0);
        touchedServiceIds.push(updateService.get(categoryId, service.name).id);
      });
      if (touchedServiceIds.length) database.prepare(`UPDATE services SET enabled = 0 WHERE category_id = ? AND id NOT IN (${touchedServiceIds.map(() => '?').join(',')})`).run(categoryId, ...touchedServiceIds);
    });
    existingCategories.filter((category) => !touchedCategoryIds.includes(category.id)).forEach((category) => { disableCategory.run(category.id); disableServices.run(category.id); });
  });
  save(parsed.data.categories);
  res.json({ success: true });
});

app.get('/api/bookings', requireAuth('admin'), (req, res) => res.json(database.prepare('SELECT bookings.*, services.name AS service_name FROM bookings JOIN services ON services.id = bookings.service_id ORDER BY appointment_date, appointment_time, bookings.id').all()));
app.get('/api/bookings/mine', requireAuth('client'), (req, res) => res.json(database.prepare('SELECT bookings.*, services.name AS service_name FROM bookings JOIN services ON services.id = bookings.service_id WHERE user_id = ? ORDER BY appointment_date, appointment_time').all(req.user.id)));
app.post('/api/bookings', requireAuth('client'), async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success || parsed.data.appointmentDate < new Date().toISOString().slice(0, 10) || !isSalonSlot(parsed.data.appointmentTime)) return res.status(400).json({ error: 'Invalid booking details, date, or salon time.' });
  const service = database.prepare('SELECT * FROM services WHERE id = ? AND enabled = 1').get(parsed.data.serviceId);
  if (!service) return res.status(400).json({ error: 'That service is currently unavailable.' });
  const clash = database.prepare("SELECT id FROM bookings WHERE appointment_date = ? AND appointment_time = ? AND status IN ('Pending', 'Confirmed')").get(parsed.data.appointmentDate, parsed.data.appointmentTime);
  if (clash) return res.status(409).json({ error: 'That date is already requested for this service.' });
  const result = database.prepare('INSERT INTO bookings (user_id, name, email, phone, location, service_id, appointment_date, appointment_time, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.user.id, parsed.data.name, req.user.email, parsed.data.phone, parsed.data.location, service.id, parsed.data.appointmentDate, parsed.data.appointmentTime, parsed.data.notes);
  const booking = { id: result.lastInsertRowid, ...parsed.data, email: req.user.email, service: service.name };
  sendBookingEmail(booking).then((sent) => database.prepare('UPDATE bookings SET email_status = ? WHERE id = ?').run(sent ? 'sent' : 'pending', booking.id)).catch((error) => { database.prepare('UPDATE bookings SET email_status = ? WHERE id = ?').run('failed', booking.id); console.error('Booking email failed:', error.message); });
  res.status(201).json(booking);
});
app.patch('/api/bookings/:id/status', requireAuth('admin'), (req, res) => { const status = z.enum(['Pending', 'Confirmed', 'Completed', 'Cancelled']).safeParse(req.body.status); if (!status.success) return res.status(400).json({ error: 'Invalid status.' }); database.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status.data, req.params.id); res.json({ success: true }); });

app.get('/api/comments', (req, res) => res.json(database.prepare("SELECT id, name, rating, message, created_at AS createdAt FROM comments WHERE status = 'approved' ORDER BY created_at DESC").all()));
app.post('/api/comments', requireAuth('client'), (req, res) => { const parsed = commentSchema.safeParse(req.body); if (!parsed.success || bannedLanguage.test(parsed.data.message)) return res.status(400).json({ error: 'Please remove strong language and check your comment.' }); const result = database.prepare('INSERT INTO comments (user_id, name, rating, message) VALUES (?, ?, ?, ?)').run(req.user.id, parsed.data.name, parsed.data.rating, parsed.data.message); res.status(201).json({ id: result.lastInsertRowid, status: 'pending' }); });
app.get('/api/admin/comments', requireAuth('admin'), (req, res) => res.json(database.prepare("SELECT id, name, rating, message, status, created_at AS createdAt FROM comments WHERE status = 'pending' ORDER BY created_at").all()));
app.patch('/api/admin/comments/:id', requireAuth('admin'), (req, res) => { const status = z.enum(['approved', 'rejected']).safeParse(req.body.status); if (!status.success) return res.status(400).json({ error: 'Invalid moderation status.' }); database.prepare('UPDATE comments SET status = ? WHERE id = ?').run(status.data, req.params.id); res.json({ success: true }); });

app.get('/api/health', (req, res) => res.json({ status: 'ok', database: 'connected' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
if (process.env.NODE_ENV !== 'test') app.listen(port, () => console.log(`Salon app running on http://localhost:${port}`));

export { app, database };
