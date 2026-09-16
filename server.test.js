import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

const testDatabase = path.join(process.cwd(), 'salon-test.db');
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = testDatabase;
process.env.ADMIN_EMAIL = 'admin@test.invalid';
process.env.ADMIN_USERNAME = 'Kekgo';
process.env.ADMIN_PASSWORD = 'ncoyanokuthula25@gmail.com';

const { app, database } = await import('./server.js');
let client;
let admin;

before(async () => {
  const register = await request(app).post('/api/auth/register').send({ email: 'client@test.invalid', password: 'client-password-123' });
  assert.equal(register.status, 201);
  client = request.agent(app);
  await client.post('/api/auth/login').send({ email: 'client@test.invalid', password: 'client-password-123' });
  admin = request.agent(app);
  await admin.post('/api/auth/login').send({ email: 'admin@test.invalid', password: 'test-admin-password-change-me' });
});

test('admin can sign in with the configured username alias', async () => {
  const usernameAdmin = request.agent(app);
  const login = await usernameAdmin.post('/api/auth/login').send({ identifier: 'Kekgo', password: 'test-admin-password-change-me' });
  assert.equal(login.status, 200);
  assert.equal(login.body.role, 'admin');
  assert.equal(login.body.username, 'Kekgo');
});

test('health endpoint reports the database', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('promotion is public and editable by admin', async () => {
  const publicPromotion = await request(app).get('/api/promotions');
  assert.equal(publicPromotion.status, 200);
  const update = await admin.put('/api/admin/promotions').send({
    title: 'Test client offer',
    description: 'A limited test promotion.',
    action: 'Book offer',
    enabled: true
  });
  assert.equal(update.status, 200);
  const updated = await request(app).get('/api/promotions');
  assert.equal(updated.body.title, 'Test client offer');
});

test('contact details are public and editable by admin', async () => {
  const update = await admin.put('/api/admin/contact').send({
    name: 'Thuli Test',
    email: 'thuli@test.invalid',
    phone: '010 000 0000',
    whatsapp: '27100000000'
  });
  assert.equal(update.status, 200);
  const contact = await request(app).get('/api/contact');
  assert.equal(contact.body.name, 'Thuli Test');
  assert.equal(contact.body.email, 'thuli@test.invalid');
});

test('admin can change login credentials with the current password', async () => {
  const update = await admin.put('/api/admin/account').send({
    currentPassword: 'test-admin-password-change-me',
    email: 'admin-updated@test.invalid',
    newPassword: 'new-admin-password-123'
  });
  assert.equal(update.status, 200);
  const newAdmin = request.agent(app);
  const login = await newAdmin.post('/api/auth/login').send({ email: 'admin-updated@test.invalid', password: 'new-admin-password-123' });
  assert.equal(login.status, 200);
  admin = newAdmin;
});

test('unauthenticated users cannot create bookings', async () => {
  const response = await request(app).post('/api/bookings').send({});
  assert.equal(response.status, 401);
});

test('client can submit a valid future time slot', async () => {
  const services = await request(app).get('/api/services');
  const serviceId = services.body[0].services[0].id;
  const response = await client.post('/api/bookings').send({
    name: 'Test Client',
    email: 'client@test.invalid',
    phone: '+27000000000',
    location: 'Test address',
    serviceId,
    appointmentDate: '2099-01-02',
    appointmentTime: '09:30',
    notes: 'Test booking'
  });
  assert.equal(response.status, 201);
});

test('admin can preserve existing services while editing categories', async () => {
  const services = await request(app).get('/api/services');
  const categories = services.body.map((category) => ({
    name: category.name,
    enabled: true,
    services: category.services.map((service) => ({ name: service.name, price: service.price, durationMinutes: service.durationMinutes, enabled: true }))
  }));
  const response = await admin.put('/api/admin/services').send({ categories });
  assert.equal(response.status, 200);
  const bookings = await admin.get('/api/bookings');
  assert.equal(bookings.status, 200);
  assert.equal(bookings.body.length, 1);
});

test('strong-language comments are rejected', async () => {
  const response = await client.post('/api/comments').send({ name: 'Test Client', rating: 1, message: 'This is shit' });
  assert.equal(response.status, 400);
});

after(() => {
  database.close();
  for (const suffix of ['', '-shm', '-wal']) {
    const file = `${testDatabase}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});
