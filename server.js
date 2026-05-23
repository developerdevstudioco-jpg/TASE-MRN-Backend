import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { getDatabaseDriver, initializeDatabase, loadCollection, saveCollection } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const PORT = process.env.PORT || 4000;
const GENERATED_JWT_SECRET = `mrn_dev_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? '' : GENERATED_JWT_SECRET);
const DEFAULT_BOOTSTRAP_ADMIN_NAME = 'System Administrator';
const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = 'somaskandhanmj@gmail.com';
const DEFAULT_BOOTSTRAP_ADMIN_EMPLOYEE_CODE = 'ADM001';
const DEFAULT_BOOTSTRAP_ADMIN_PASSWORD = 'Kandhan28@@';
const PRIMARY_ADMIN_ID = 'u_primary_admin';
const LEGACY_PRIMARY_ADMIN_IDS = new Set([`u_${DEFAULT_BOOTSTRAP_ADMIN_EMAIL}`]);
const ADMIN_NAME = String(process.env.ADMIN_NAME || DEFAULT_BOOTSTRAP_ADMIN_NAME).trim() || DEFAULT_BOOTSTRAP_ADMIN_NAME;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || DEFAULT_BOOTSTRAP_ADMIN_EMAIL).trim().toLowerCase();
const ADMIN_EMPLOYEE_CODE = String(process.env.ADMIN_EMPLOYEE_CODE || DEFAULT_BOOTSTRAP_ADMIN_EMPLOYEE_CODE).trim().toUpperCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? '' : DEFAULT_BOOTSTRAP_ADMIN_PASSWORD);
const SECONDARY_ADMIN_NAME = String(process.env.SECONDARY_ADMIN_NAME || '').trim();
const SECONDARY_ADMIN_EMAIL = String(process.env.SECONDARY_ADMIN_EMAIL || '').trim().toLowerCase();
const SECONDARY_ADMIN_EMPLOYEE_CODE = String(process.env.SECONDARY_ADMIN_EMPLOYEE_CODE || '').trim().toUpperCase();
const SECONDARY_ADMIN_PASSWORD = process.env.SECONDARY_ADMIN_PASSWORD || '';
const DEFAULT_DEV_PASSWORDS = {
  admin: DEFAULT_BOOTSTRAP_ADMIN_PASSWORD,
  requester: 'Requester123',
  issuer: 'Issuer123',
};
const PASSWORD_HASH_PREFIX = 'scrypt';
const PASSWORD_SETUP_EXPIRY = '15m';
const MAIL_FROM = process.env.MAIL_FROM || 'MRS System <no-reply@example.com>';
const DEFAULT_PRODUCTION_FRONTEND_URL = 'http://localhost:5173';
const DEFAULT_PRODUCTION_BACKEND_URL = 'http://localhost:4000';
const BREVO_SMTP_HOST = 'smtp-relay.brevo.com';
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_USE_API = process.env.BREVO_USE_API === 'true';
const FRONTEND_URL = String(
  process.env.FRONTEND_URL
  || process.env.APP_FRONTEND_URL
  || DEFAULT_PRODUCTION_FRONTEND_URL
).trim().replace(/\/+$/, '');
const BACKEND_URL = String(
  process.env.BACKEND_URL
  || process.env.APP_BACKEND_URL
  || DEFAULT_PRODUCTION_BACKEND_URL
).trim().replace(/\/+$/, '');
const EMAIL_LOGO_PATH = path.resolve(__dirname, '..', 'src', 'assets', 'logo.png');
const EMAIL_LOGO_CID = 'tase-digital-logo';
const PUPPETEER_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_BIN,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
let mailTransporter = null;
let mailTransporterName = 'console';
let mailTransporterMode = 'console';
let mailTransporterError = null;
let mailTransporterDetails = {
  host: null,
  port: null,
  secure: false,
  requireTLS: false,
  from: MAIL_FROM,
};

const updateMailTransportDetails = ({ host = null, port = null, secure = false, requireTLS = false } = {}) => {
  mailTransporterDetails = {
    host,
    port,
    secure,
    requireTLS,
    from: MAIL_FROM,
  };
};

const getMailDiagnostics = () => ({
  configured: Boolean(mailTransporterDetails.host),
  active: Boolean(mailTransporter) || mailTransporterMode === 'brevo-api',
  transport: mailTransporterName,
  mode: mailTransporterMode,
  host: mailTransporterDetails.host,
  port: mailTransporterDetails.port,
  secure: mailTransporterDetails.secure,
  requireTLS: mailTransporterDetails.requireTLS,
  from: mailTransporterDetails.from,
  error: mailTransporterError,
});

const parseCorsOrigins = () => {
  if (process.env.CORS_ORIGINS) {
    return process.env.CORS_ORIGINS
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  return [DEFAULT_PRODUCTION_FRONTEND_URL];
};

const CORS_ORIGINS = parseCorsOrigins();

const isBrevoHost = (host) => String(host || '').trim().toLowerCase() === BREVO_SMTP_HOST;

const getBrevoApiKey = ({ mailHost, mailPass }) => {
  if (!isBrevoHost(mailHost)) {
    return '';
  }

  return String(process.env.BREVO_API_KEY || '').trim();
};

const configureBrevoApiTransport = ({ apiKey, reason = '' } = {}) => {
  if (!apiKey) {
    return false;
  }

  mailTransporter = null;
  mailTransporterName = 'Brevo API';
  mailTransporterMode = 'brevo-api';
  mailTransporterError = reason || null;
  updateMailTransportDetails({
    host: 'api.brevo.com',
    port: 443,
    secure: true,
    requireTLS: false,
  });
  return true;
};

const parseMailbox = (value) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*)<([^>]+)>$/);

  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, ''),
      email: match[2].trim(),
    };
  }

  return {
    name: '',
    email: raw,
  };
};

const toBrevoAttachments = (attachments = []) =>
  attachments
    .map((attachment) => {
      if (attachment?.path && fs.existsSync(attachment.path)) {
        return {
          name: attachment.filename || path.basename(attachment.path),
          content: fs.readFileSync(attachment.path).toString('base64'),
        };
      }

      if (attachment?.content) {
        const content =
          Buffer.isBuffer(attachment.content)
            ? attachment.content.toString('base64')
            : Buffer.from(String(attachment.content)).toString('base64');

        return {
          name: attachment.filename || 'attachment',
          content,
        };
      }

      return null;
    })
    .filter(Boolean);

const sendViaBrevoApi = async ({ to, subject, text, html, attachments = [] }) => {
  const apiKey = getBrevoApiKey({
    mailHost: process.env.MAIL_HOST,
    mailPass: process.env.MAIL_PASS,
  });

  if (!apiKey) {
    throw new Error('Brevo API key is missing. Set BREVO_API_KEY for Brevo API delivery.');
  }

  const sender = parseMailbox(MAIL_FROM);
  if (!sender.email || sender.email.endsWith('@example.com')) {
    throw new Error('MAIL_FROM must use a real, Brevo-verified sender email address.');
  }

  const payload = {
    sender: sender.name ? sender : { email: sender.email },
    to: [{ email: to }],
    subject,
    ...(html ? { htmlContent: html } : { textContent: text }),
    ...(attachments.length > 0 ? { attachment: toBrevoAttachments(attachments) } : {}),
  };

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseData = null;
  if (responseText) {
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }
  }

  if (!response.ok) {
    const errorMessage =
      typeof responseData === 'object' && responseData && 'message' in responseData
        ? String(responseData.message || '')
        : response.statusText;
    throw new Error(errorMessage || 'Brevo API request failed.');
  }

  return responseData;
};

const enableLocalStreamMailTransport = (reason) => {
  if (reason) {
    console.log(reason);
  }

  mailTransporterError = null;
  updateMailTransportDetails();
  mailTransporter = nodemailer.createTransport({
    streamTransport: true,
    newline: 'unix',
    buffer: true,
  });
  mailTransporterName = 'stream';
  mailTransporterMode = 'stream';
};

const initMailTransporter = async () => {
  const mailHost = process.env.MAIL_HOST;
  const mailPort = Number(process.env.MAIL_PORT || 587);
  const mailUser = process.env.MAIL_USER;
  const mailPass = process.env.MAIL_PASS;
  const brevoApiKey = getBrevoApiKey({ mailHost, mailPass });
  const mailEncryption = String(process.env.MAIL_ENCRYPTION || '').trim().toLowerCase();
  const mailSecure = process.env.MAIL_SECURE === 'true' || mailEncryption === 'ssl' || mailPort === 465;
  const mailRequireTLS = mailEncryption === 'tls';
  updateMailTransportDetails({
    host: mailHost || null,
    port: mailHost ? mailPort : null,
    secure: mailSecure,
    requireTLS: mailRequireTLS,
  });

  if (BREVO_USE_API && configureBrevoApiTransport({ apiKey: brevoApiKey })) {
    console.log('Using Brevo API transport for email delivery.');
    return;
  }
  if (BREVO_USE_API && isBrevoHost(mailHost) && !brevoApiKey) {
    console.warn('BREVO_USE_API is enabled, but BREVO_API_KEY is missing. Falling back to SMTP configuration.');
  }

  if (mailHost && mailUser && mailPass) {
    mailTransporter = nodemailer.createTransport({
      host: mailHost,
      port: mailPort,
      secure: mailSecure,
      requireTLS: mailRequireTLS,
      auth: {
        user: mailUser,
        pass: mailPass,
      },
    });
    mailTransporterName = mailHost;
    mailTransporterMode = 'smtp';
    try {
      await mailTransporter.verify();
      mailTransporterError = null;
      console.log(`SMTP mail transport configured via ${mailHost}`);
    } catch (error) {
      const smtpError = error instanceof Error ? error.message : String(error);
      if (configureBrevoApiTransport({
        apiKey: brevoApiKey,
        reason: `SMTP verification failed; switched to Brevo API. Original error: ${smtpError}`,
      })) {
        console.warn('SMTP verification failed; using Brevo API transport instead.');
        return;
      }

      mailTransporterError = smtpError;
      console.error('SMTP mail transport verification failed:', error);
      if (!IS_PRODUCTION) {
        enableLocalStreamMailTransport(
          'Falling back to local stream transport for development. Email content will be written to backend logs.'
        );
      } else {
        mailTransporter = null;
        mailTransporterName = 'console';
        mailTransporterMode = 'console';
      }
    }
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    try {
      const testAccount = await nodemailer.createTestAccount();
      mailTransporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      mailTransporterError = null;
      updateMailTransportDetails({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        requireTLS: false,
      });
      mailTransporterName = 'Ethereal';
      mailTransporterMode = 'ethereal';
      console.log('Using Ethereal test email service for development. Email preview URLs will be logged.');
      return;
    } catch (error) {
      mailTransporterError = error instanceof Error ? error.message : String(error);
      console.warn('Failed to initialize Ethereal test mail service:', error);
      enableLocalStreamMailTransport(
        'Falling back to local stream transport for email testing. Emails will be printed to backend logs.'
      );
      return;
    }
  }

  console.log('Mail transport is not configured. Emails will be logged to the console only.');
};

if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY);
}

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin not allowed'));
  },
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb' }));

app.get('/', (req, res) => {
  res.send('MRS backend is running');
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', environment: NODE_ENV });
});

app.get('/readyz', (req, res) => {
  res.json({
    status: 'ready',
    environment: NODE_ENV,
    mail: getMailDiagnostics(),
    database: getDatabaseDriver(),
  });
});

const seededNotifications = [];

const buildSeedAvatar = (name) =>
  String(name)
    .split(' ')
    .map((part) => part[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'NA';

const createBootstrapAdminSeed = ({
  id,
  name,
  email,
  password,
  employeeCode,
}) => ({
  id,
  name,
  email,
  password,
  role: 'Admin',
  department: 'Admin',
  employeeCode,
  designation: 'Director',
  team: '',
  status: 'Active',
  avatar: buildSeedAvatar(name),
  lastActive: new Date().toISOString(),
});

const buildBootstrapAdminConfigs = () => {
  const configs = [
    {
      id: PRIMARY_ADMIN_ID,
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      employeeCode: ADMIN_EMPLOYEE_CODE,
      isPrimary: true,
    },
  ];

  if (SECONDARY_ADMIN_EMAIL && SECONDARY_ADMIN_EMPLOYEE_CODE && SECONDARY_ADMIN_PASSWORD) {
    configs.push({
      id: `u_admin_${SECONDARY_ADMIN_EMPLOYEE_CODE.toLowerCase()}`,
      name: SECONDARY_ADMIN_NAME || SECONDARY_ADMIN_EMPLOYEE_CODE,
      email: SECONDARY_ADMIN_EMAIL,
      password: SECONDARY_ADMIN_PASSWORD,
      employeeCode: SECONDARY_ADMIN_EMPLOYEE_CODE,
      isPrimary: false,
    });
  }

  return configs;
};

const seededUsers = [
  ...buildBootstrapAdminConfigs().map(createBootstrapAdminSeed),
];

const seededMrns = [];
const seededHistoryRecords = [];

let notifications = structuredClone(seededNotifications);
let users = structuredClone(seededUsers);
let mrns = structuredClone(seededMrns);
let historyRecords = structuredClone(seededHistoryRecords);
let passwordResetRequests = [];

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ message: 'Missing authorization token' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

const authorize = (allowedRoles = []) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
  if (allowedRoles.length === 0 || allowedRoles.includes(req.user.role)) {
    return next();
  }
  return res.status(403).json({ message: 'Insufficient permissions' });
};

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  department: user.department,
  employeeCode: user.employeeCode,
  designation: user.designation,
  team: user.team,
  status: user.status,
  avatar: user.avatar,
  lastActive: user.lastActive,
  mustChangePassword: Boolean(user.mustChangePassword),
});

const validateNewPassword = (password) => {
  const normalizedPassword = String(password || '');

  if (normalizedPassword.length < 6) {
    return 'Password must be at least 6 characters';
  }

  if (!/[A-Z]/.test(normalizedPassword) && !/[a-z]/.test(normalizedPassword) && !/[0-9]/.test(normalizedPassword)) {
    return 'Password must contain letters or numbers';
  }

  return '';
};

const hashPassword = (password) => {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${PASSWORD_HASH_PREFIX}$${salt}$${hash}`;
};

const isPasswordHash = (value) =>
  typeof value === 'string' && value.startsWith(`${PASSWORD_HASH_PREFIX}$`);

const verifyPassword = (password, storedPassword) => {
  if (!storedPassword) {
    return false;
  }

  if (!isPasswordHash(storedPassword)) {
    return String(password) === String(storedPassword);
  }

  const [, salt, storedHash] = String(storedPassword).split('$');
  if (!salt || !storedHash) {
    return false;
  }

  const derivedHash = scryptSync(String(password), salt, 64);
  const storedHashBuffer = Buffer.from(storedHash, 'hex');

  if (derivedHash.length !== storedHashBuffer.length) {
    return false;
  }

  return timingSafeEqual(derivedHash, storedHashBuffer);
};

const buildAvatar = (name) =>
  String(name)
    .split(' ')
    .map((part) => part[0] || '')
    .join('')
  .slice(0, 2)
  .toUpperCase() || 'NA';

const normalizeDepartmentName = (value) => {
  const trimmedValue = String(value || '').trim();
  const normalizedAliasMap = {
    'quallity assurance': 'Quality Assurance',
    'quality assurance': 'Quality Assurance',
    maintenace: 'Maintenance',
    maintenance: 'Maintenance',
  };

  return normalizedAliasMap[trimmedValue.toLowerCase()] || trimmedValue;
};

const TEAM_OPTIONS_BY_DEPARTMENT = {
  Production: ['Operator', 'Tool Crib', 'Bench Work', 'Tool Room', 'PPC'],
  Engineering: ['CAD', 'CAM'],
  'Quality Assurance': [],
  QMS: [],
  Materials: ['Purchase', 'Store', 'Warehouse'],
  Maintenance: [],
  Management: [],
  Admin: [],
  HR: [],
};

const getDepartmentTeamOptions = (department) =>
  TEAM_OPTIONS_BY_DEPARTMENT[normalizeDepartmentName(department)] || [];

const departmentRequiresTeam = (department) =>
  getDepartmentTeamOptions(department).length > 0;

const resolveUserTeam = (department, team) => {
  const trimmedTeam = String(team || '').trim();
  const options = getDepartmentTeamOptions(department);

  if (options.length === 0) {
    return '';
  }

  return options.includes(trimmedTeam) ? trimmedTeam : '';
};

const isQmsDepartment = (department) => normalizeDepartmentName(department) === 'QMS';
const hasSystemAdminAccess = (user) =>
  Boolean(user && (user.role === 'Admin' || user.role === 'Management' || isQmsDepartment(user.department)));
const canCreateMRS = (user) =>
  Boolean(user && ['Admin', 'Requester', 'L1 Approver', 'L2 Approver', 'Issuer'].includes(user.role));
const canReturnMRS = (user, mrn) =>
  Boolean(
    user
    && (
      user.role === 'Admin'
      || (canCreateMRS(user) && mrn?.requester === user.name)
    )
  );

const canReadMRS = (user, mrn) => {
  if (!user || !mrn) {
    return false;
  }

  if (hasSystemAdminAccess(user) || user.role === 'L2 Approver' || user.role === 'Issuer') {
    return true;
  }

  if (user.role === 'L1 Approver') {
    return canApproveAsL1(user, mrn) || mrn.requester === user.name;
  }

  return canCreateMRS(user) && mrn.requester === user.name;
};

const getVisibleMRNs = (user) => {
  if (!user) {
    return [];
  }

  if (hasSystemAdminAccess(user) || user.role === 'L2 Approver' || user.role === 'Issuer') {
    return mrns;
  }

  if (user.role === 'L1 Approver') {
    return mrns.filter((mrn) => canApproveAsL1(user, mrn) || mrn.requester === user.name);
  }

  if (canCreateMRS(user)) {
    return mrns.filter((mrn) => mrn.requester === user.name);
  }

  return [];
};

const canApproveAsL1 = (user, mrn) =>
  Boolean(
    user
    && user.role === 'L1 Approver'
    && normalizeDepartmentName(user.department) === normalizeDepartmentName(mrn.department)
    && mrn.requester !== user.name
  );

const canApproveAsL2 = (user, mrn) =>
  Boolean(
    user
    && user.role === 'L2 Approver'
    && normalizeDepartmentName(user.department) === 'Materials'
  );

const resolveBrowserExecutablePath = () => {
  const executablePath = PUPPETEER_EXECUTABLE_CANDIDATES.find((candidate) => fs.existsSync(candidate));

  if (!executablePath) {
    throw new Error(
      'No Chromium browser executable was found for PDF export. Set PUPPETEER_EXECUTABLE_PATH or install Chrome/Edge.'
    );
  }

  return executablePath;
};

const buildPdfHtmlDocument = ({ content, styles = '', title = 'Document', baseUrl = '' }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${baseUrl ? `<base href="${escapeHtml(baseUrl)}" />` : ''}
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        color-adjust: exact;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      body {
        min-height: 100%;
      }

      /* PDF print helpers: keep table headers, allow row breaks, and ensure images scale */
      .mrn-document-sheet {
        box-sizing: border-box;
        width: 297mm;
        height: 210mm;
      }

      .mrn-document-table {
        border-collapse: collapse;
        page-break-inside: auto;
        width: 100%;
      }

      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }
      tr { page-break-inside: avoid; page-break-after: auto; }

      img { max-width: 100%; height: auto; display: block; }
      td, th { word-break: break-word; }

      @media print {
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }
    </style>
    <style>${styles}</style>
  </head>
  <body>
    ${content}
  </body>
</html>`;

const generatePdfBuffer = async ({
  html,
  styles,
  title,
  pageFormat = 'a4',
  orientation = 'portrait',
  margin = 5,
  baseUrl = '',
}) => {
  const browser = await puppeteer.launch({
    executablePath: resolveBrowserExecutablePath(),
    headless: 'new',
    timeout: 120000,
    args: ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1810, deviceScaleFactor: 1 });
    await page.setContent(
      buildPdfHtmlDocument({
        content: html,
        styles,
        title,
        baseUrl,
      }),
      { waitUntil: 'networkidle0' }
    );
    await page.emulateMediaType('screen');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });

      const imageLoadPromises = Array.from(document.images)
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise((resolve) => {
              img.onload = img.onerror = resolve;
            })
        );

      await Promise.all([
        ...imageLoadPromises,
        document.fonts?.ready || Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    });

    return await page.pdf({
      format: pageFormat.toUpperCase(),
      landscape: orientation === 'landscape',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: `${margin}mm`,
        right: `${margin}mm`,
        bottom: `${margin}mm`,
        left: `${margin}mm`,
      },
    });
  } finally {
    await browser.close();
  }
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const nl2br = (value) => escapeHtml(value).replace(/\r?\n/g, '<br />');

const getEmailLogoAttachments = () =>
  fs.existsSync(EMAIL_LOGO_PATH)
    ? [{
        filename: 'tase-digital-logo.png',
        path: EMAIL_LOGO_PATH,
        cid: EMAIL_LOGO_CID,
      }]
    : [];

const buildEmailBrandMark = () =>
  fs.existsSync(EMAIL_LOGO_PATH)
    ? `<div style="display: inline-flex; align-items: center; justify-content: center; min-width: 180px; max-width: 220px; border-radius: 26px; background-color: #ffffff; padding: 14px 18px; box-shadow: 0 16px 34px rgba(60, 14, 121, 0.22); border: 1px solid rgba(226, 232, 240, 0.95);">
        <img src="cid:${EMAIL_LOGO_CID}" alt="TASE Digital logo" width="180" style="display: block; width: 100%; max-width: 180px; height: auto;" />
      </div>`
    : `<div style="min-width: 180px; border-radius: 26px; background-color: #ffffff; color: #3c0e79; font-size: 28px; font-weight: 700; line-height: 1; text-align: center; padding: 22px 18px; box-shadow: 0 16px 34px rgba(60, 14, 121, 0.22); border: 1px solid rgba(226, 232, 240, 0.95);">TASE</div>`;

const buildEmailShell = ({
  preheader,
  title,
  intro,
  bodyHtml,
  buttonLabel = 'Access your app',
  buttonUrl = FRONTEND_URL,
  footerTitle = 'TASE Digital MRS',
}) => {
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safePreheader = escapeHtml(preheader || intro || title);
  const safeButtonLabel = escapeHtml(buttonLabel);
  const safeButtonUrl = escapeHtml(buttonUrl);
  const safeFooterTitle = escapeHtml(footerTitle);
  const safeFrontendUrl = escapeHtml(FRONTEND_URL);
  const safeBackendUrl = escapeHtml(BACKEND_URL);
  const brandMarkHtml = buildEmailBrandMark();

  return `
    <!doctype html>
    <html lang="en">
      <body style="margin: 0; padding: 0; background-color: #f5f0fb; font-family: Arial, sans-serif; color: #0f172a;">
        <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${safePreheader}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f0fb; padding: 24px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 640px;">
                <tr>
                  <td style="padding-bottom: 16px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius: 24px; overflow: hidden; background: linear-gradient(135deg, #2b0a58 0%, #3c0e79 56%, #6d28d9 100%);">
                      <tr>
                        <td align="center" style="padding: 30px 32px 34px; text-align: center;">
                          <div style="margin: 0 0 18px;">${brandMarkHtml}</div>
                          <p style="margin: 0; font-size: 12px; line-height: 18px; letter-spacing: 0.24em; text-transform: uppercase; color: rgba(255, 255, 255, 0.72);">TASE Digital</p>
                          <h1 style="margin: 8px 0 0; font-size: 28px; line-height: 34px; color: #ffffff;">${safeTitle}</h1>
                          <p style="margin: 18px 0 0; font-size: 15px; line-height: 24px; color: rgba(255, 255, 255, 0.88);">${safeIntro}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #ffffff; border-radius: 24px; padding: 32px; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08);">
                    ${bodyHtml}
                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0 20px;">
                      <tr>
                        <td align="center" bgcolor="#3c0e79" style="border-radius: 999px;">
                          <a href="${safeButtonUrl}" style="display: inline-block; padding: 14px 26px; font-size: 15px; font-weight: 700; color: #ffffff; text-decoration: none;">${safeButtonLabel}</a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 0 0 8px; font-size: 13px; line-height: 21px; color: #475569;">If the button does not open, copy this link into your browser:</p>
                    <p style="margin: 0; font-size: 13px; line-height: 22px; word-break: break-all;">
                      <a href="${safeButtonUrl}" style="color: #3c0e79; text-decoration: none;">${safeButtonUrl}</a>
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px 8px 0; text-align: center;">
                    <p style="margin: 0 0 6px; font-size: 12px; line-height: 18px; color: #64748b;">${safeFooterTitle}</p>
                    <p style="margin: 0; font-size: 12px; line-height: 18px; color: #94a3b8;">
                      Portal:
                      <a href="${safeFrontendUrl}" style="color: #64748b; text-decoration: none;">${safeFrontendUrl}</a>
                      &nbsp;|&nbsp;
                      API:
                      <a href="${safeBackendUrl}" style="color: #64748b; text-decoration: none;">${safeBackendUrl}</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
};

const normalizeEmployeeCode = (value) => String(value || '').trim().toUpperCase();

const findUserByEmployeeCode = (employeeCode) =>
  users.find((user) => normalizeEmployeeCode(user.employeeCode) === normalizeEmployeeCode(employeeCode));

const findPrimaryAdminIndex = () =>
  users.findIndex((user) =>
    user.id === PRIMARY_ADMIN_ID
    || LEGACY_PRIMARY_ADMIN_IDS.has(user.id)
    || user.email === ADMIN_EMAIL
    || normalizeEmployeeCode(user.employeeCode) === ADMIN_EMPLOYEE_CODE
  );

const findBootstrapAdminIndex = (seed) =>
  users.findIndex((user) =>
    user.id === seed.id
    || user.email === seed.email
    || normalizeEmployeeCode(user.employeeCode) === normalizeEmployeeCode(seed.employeeCode)
  );

const getAdminUser = () => {
  const index = findPrimaryAdminIndex();
  return index === -1 ? null : users[index];
};

const getRequesterUser = (mrn) =>
  users.find((user) => canCreateMRS(user) && user.name === mrn.requester);

const sanitizeQty = (value) => {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 0) return 0;
  return qty;
};

const getRequestedQty = (item) => sanitizeQty(item.requestedQty ?? item.qty);
const getIssuedQty = (item) => sanitizeQty(item.issuedQty);
const getReturnedQty = (item) => sanitizeQty(item.returnedQty);
const CLOSED_MRN_STATUSES = ['Rejected', 'Issued', 'Returned', 'Not Available'];

const getMaterialApprovalStatus = (item) => {
  const approvalStatus = String(item.approvalStatus || '').trim();
  return ['Approved', 'Hold', 'Rejected'].includes(approvalStatus) ? approvalStatus : 'Pending';
};

const getMaterialApprovalStatusByMrnStatus = (status) => {
  if (status === 'Approved' || status === 'Partially Issued' || status === 'Issued' || status === 'Partially Returned' || status === 'Returned' || status === 'Not Available') {
    return 'Approved';
  }

  if (status === 'Hold') {
    return 'Hold';
  }

  if (status === 'Rejected') {
    return 'Rejected';
  }

  return 'Pending';
};

const summarizeGrnNumbers = (materials = []) => {
  const grnNumbers = Array.from(
    new Set(
      materials
        .map((item) => String(item.grnNumber || '').trim())
        .filter(Boolean)
    )
  );

  if (grnNumbers.length === 0) {
    return '';
  }

  if (grnNumbers.length === 1) {
    return grnNumbers[0];
  }

  return grnNumbers.join(', ');
};

const isClosedMrnStatus = (status) => CLOSED_MRN_STATUSES.includes(status);

const deriveMaterialStatus = (item) => {
  const requestedQty = getRequestedQty(item);
  const issuedQty = getIssuedQty(item);
  const returnedQty = getReturnedQty(item);

  if (item.status === 'Not Available' && issuedQty === 0) {
    return 'Not Available';
  }

  if (issuedQty === 0) {
    return 'Pending';
  }

  if (returnedQty >= issuedQty) {
    return 'Returned';
  }

  if (returnedQty > 0) {
    return 'Partially Returned';
  }

  if (issuedQty < requestedQty) {
    return 'Partially Issued';
  }

  return 'Issued';
};

const deriveMRNStatus = (mrn) => {
  const materials = mrn.materials || [];
  const totalIssued = materials.reduce((sum, item) => sum + getIssuedQty(item), 0);
  const totalReturned = materials.reduce((sum, item) => sum + getReturnedQty(item), 0);
  const totalRequested = materials.reduce((sum, item) => sum + getRequestedQty(item), 0);

  if (materials.length > 0 && materials.every((item) => item.status === 'Not Available')) {
    return 'Not Available';
  }

  if (totalIssued === 0) {
    return mrn.approvalLevel >= 2 && mrn.status !== 'Hold' ? 'Approved' : mrn.status;
  }

  if (totalReturned > 0) {
    return totalReturned >= totalIssued ? 'Returned' : 'Partially Returned';
  }

  if (totalIssued < totalRequested) {
    return 'Partially Issued';
  }

  return 'Issued';
};

const normalizeMaterial = (item) => {
  const requestedQty = getRequestedQty(item);
  const issuedQty = Math.min(sanitizeQty(item.issuedQty), requestedQty);
  const returnedQty = Math.min(sanitizeQty(item.returnedQty), issuedQty);
  const normalized = {
    id: item.id,
    materialCode: String(item.materialCode || '').trim(),
    description: String(item.description || '').trim(),
    spec: String(item.spec || '').trim(),
    uom: String(item.uom || 'PCS').trim(),
    requestedQty,
    issuedQty,
    returnedQty,
    grnNumber: String(item.grnNumber || '').trim(),
    approvalStatus: getMaterialApprovalStatus(item),
    status: item.status,
  };

  return {
    ...normalized,
    status: deriveMaterialStatus(normalized),
  };
};

const pushNotification = ({ userId, title, message, type = 'system', mrnId }) => {
  notifications.unshift({
    id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    title,
    message,
    type,
    mrnId,
    read: false,
    timestamp: new Date().toISOString(),
  });
  saveNotifications();
};

const pushHistoryRecord = ({ action, actor, actorRole, mrn, summary }) => {
  const timestamp = new Date().toISOString();

  historyRecords.unshift({
    id: `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    documentId: mrn.id,
    action,
    actor,
    actorRole,
    department: normalizeDepartmentName(mrn.department || ''),
    status: mrn.status,
    summary,
    snapshot: {
      requester: mrn.requester,
      purpose: mrn.purpose || '',
      priority: mrn.priority || 'Medium',
      itemCount: Array.isArray(mrn.materials) ? mrn.materials.length : 0,
    },
  });
  saveHistoryRecords();
};

const notifyClosedMrn = ({ mrn, actor, action }) => {
  const requester = getRequesterUser(mrn);
  const closedLabel = mrn.status === 'Not Available' ? 'closed as not available' : `closed as ${mrn.status}`;
  const notificationTargets = new Set(
    [requester?.id, getAdminUser()?.id].filter(Boolean)
  );

  notificationTargets.forEach((userId) => {
    pushNotification({
      userId,
      title: `${mrn.id} closed`,
      message: `${mrn.id} has been ${closedLabel} by ${actor} via ${action.replace('_', ' ')} flow.`,
      type: 'closed',
      mrnId: mrn.id,
    });
  });
};

const completeActiveTimelineSteps = (mrn) => {
  mrn.timeline = mrn.timeline.map((step) =>
    step.status === 'active'
      ? { ...step, status: 'completed', timestamp: step.timestamp || new Date().toISOString() }
      : step
  );
};

const transitionRules = {
  Submitted: ['approve', 'hold', 'reject'],
  Hold: ['approve', 'hold', 'reject'],
  Approved: ['issue', 'issuer_hold', 'not_available'],
  'Partially Issued': ['issue', 'issuer_hold', 'return'],
  Rejected: [],
  Issued: ['return'],
  'Partially Returned': ['return'],
  Returned: [],
  'Not Available': [],
};

const APPROVER_WORKFLOW_ACTIONS = new Set(['approve', 'hold', 'reject']);

const canRequesterManageMrn = (mrn, user) =>
  canCreateMRS(user)
  && mrn.requester === user.name
  && (mrn.approvalLevel || 0) === 0
  && mrn.status === 'Submitted';

const canManageMrn = (mrn, user) =>
  user?.role === 'Admin' || canRequesterManageMrn(mrn, user);

const buildMrnMaterials = (materials = [], existingMaterials = []) => {
  const existingById = new Map(existingMaterials.map((item) => [String(item.id), item]));
  const incomingIds = new Set(
    materials
      .map((item) => String(item.id || '').trim())
      .filter(Boolean)
  );

  const removedTrackedLine = existingMaterials.find((item) =>
    !incomingIds.has(String(item.id))
    && (getIssuedQty(item) > 0 || getReturnedQty(item) > 0)
  );

  if (removedTrackedLine) {
    throw new Error(
      `You cannot remove ${removedTrackedLine.materialCode} because issue or return activity already exists for that line`
    );
  }

  return materials.map((item, index) => {
    const existing = existingById.get(String(item.id || ''));
    const requestedQty = sanitizeQty(item.requestedQty ?? item.qty);
    const issuedQty = existing ? getIssuedQty(existing) : 0;
    const returnedQty = existing ? getReturnedQty(existing) : 0;

    if (issuedQty > requestedQty) {
      throw new Error(
        `Requested quantity cannot be lower than already issued quantity for ${String(item.materialCode || `line ${index + 1}`).trim()}`
      );
    }

    const normalized = normalizeMaterial({
      id: existing?.id || `m-${Date.now()}-${index}`,
      materialCode: item.materialCode,
      description: item.description,
      spec: item.spec,
      uom: item.uom,
      requestedQty,
      issuedQty,
      returnedQty,
      grnNumber: existing?.grnNumber || '',
      approvalStatus: existing?.approvalStatus || 'Pending',
      status: existing?.status || 'Pending',
    });

    if (!normalized.materialCode || !normalized.description) {
      throw new Error(`Material code and description are required for line ${index + 1}`);
    }

    if (normalized.requestedQty <= 0) {
      throw new Error(`Requested quantity must be greater than 0 for ${normalized.materialCode}`);
    }

    return normalized;
  });
};

const saveUsers = () => saveCollection('users', users);
const saveMrns = () => saveCollection('mrns', mrns);
const saveNotifications = () => saveCollection('notifications', notifications);
const saveHistoryRecords = () => saveCollection('historyRecords', historyRecords);

const ensureBootstrapAdmins = () => {
  const bootstrapConfigs = buildBootstrapAdminConfigs();
  const normalizedSeeds = normalizeStoredUsers(
    bootstrapConfigs.map((config) => createBootstrapAdminSeed(config))
  );

  normalizedSeeds.forEach((seed, index) => {
    const config = bootstrapConfigs[index];
    const existingIndex = findBootstrapAdminIndex(seed);

    if (existingIndex === -1) {
      if (config.isPrimary) {
        users.unshift(seed);
      } else {
        users.push(seed);
      }
      return;
    }

    const existing = users[existingIndex];
    const nextPassword =
      config.password && !verifyPassword(config.password, existing.password)
        ? seed.password
        : existing.password;

    users[existingIndex] = {
      ...existing,
      ...seed,
      id: config.isPrimary ? PRIMARY_ADMIN_ID : seed.id,
      password: nextPassword,
      role: 'Admin',
      department: 'Admin',
      team: '',
      status: 'Active',
    };
  });

  const primaryIndex = findPrimaryAdminIndex();
  if (primaryIndex > 0) {
    const [primaryAdmin] = users.splice(primaryIndex, 1);
    users.unshift(primaryAdmin);
  }
};

const normalizeStoredUsers = (items) =>
  items.map((user) => {
    const normalizedPassword = isPasswordHash(user.password)
      ? user.password
      : hashPassword(user.password || DEFAULT_DEV_PASSWORDS.requester);

    return {
      ...user,
      email: String(user.email || '').trim().toLowerCase(),
      department: normalizeDepartmentName(user.department || 'Engineering'),
      employeeCode: normalizeEmployeeCode(user.employeeCode),
      designation: String(user.designation || user.companyRole || 'Engineer').trim(),
      team: resolveUserTeam(user.department || 'Engineering', user.team || ''),
      password: normalizedPassword,
      mustChangePassword: Boolean(user.mustChangePassword),
      avatar: user.avatar || buildAvatar(user.name),
      lastActive: user.lastActive || new Date().toISOString(),
    };
  });

const normalizeHistoryRecords = (items) =>
  items
    .filter(Boolean)
    .filter((record) => {
      const timestamp = new Date(record.timestamp || 0);
      return !Number.isNaN(timestamp.getTime());
    })
    .map((record) => ({
      id: record.id || `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: record.timestamp,
      documentId: String(record.documentId || ''),
      action: record.action || 'update',
      actor: String(record.actor || 'System'),
      actorRole: String(record.actorRole || 'System'),
      department: normalizeDepartmentName(record.department || ''),
      status: String(record.status || ''),
      summary: String(record.summary || ''),
      snapshot: record.snapshot || {},
    }))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

const getMRSYear = (dateValue) => {
  const parsedDate = new Date(`${String(dateValue || '').trim()}T00:00:00`);
  return Number.isNaN(parsedDate.getTime()) ? new Date().getFullYear() : parsedDate.getFullYear();
};

const formatMRSId = (year, count) => `MRS/${year}/${String(count).padStart(4, '0')}`;

const normalizeMRSIdentifiers = (items) => {
  const yearSequenceMap = new Map();
  const legacyIdMap = new Map();

  items.forEach((mrn) => {
    const existingId = String(mrn.id || '').trim();
    const match = existingId.match(/^MRS\/(\d{4})\/(\d{4})$/);
    if (!match) {
      return;
    }

    const year = Number(match[1]);
    const count = Number(match[2]);
    if (!Number.isFinite(year) || !Number.isFinite(count)) {
      return;
    }

    yearSequenceMap.set(year, Math.max(yearSequenceMap.get(year) || 0, count));
  });

  const sortedLegacyItems = [...items]
    .filter((mrn) => !/^MRS\/\d{4}\/\d{4}$/.test(String(mrn.id || '').trim()))
    .sort((a, b) => {
      const yearDiff = getMRSYear(a.date) - getMRSYear(b.date);
      if (yearDiff !== 0) return yearDiff;
      const dateDiff = String(a.date || '').localeCompare(String(b.date || ''));
      if (dateDiff !== 0) return dateDiff;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

  sortedLegacyItems.forEach((mrn) => {
    const year = getMRSYear(mrn.date);
    const nextCount = (yearSequenceMap.get(year) || 0) + 1;
    yearSequenceMap.set(year, nextCount);
    legacyIdMap.set(String(mrn.id || ''), formatMRSId(year, nextCount));
  });

  return {
    normalizedItems: items.map((mrn) => ({
      ...mrn,
      id: legacyIdMap.get(String(mrn.id || '')) || String(mrn.id || ''),
    })),
    legacyIdMap,
  };
};

const normalizeMRNs = (items) => {
  const { normalizedItems, legacyIdMap } = normalizeMRSIdentifiers(items);

  return {
    mrns: normalizedItems.map((mrn) => {
    const normalizedMaterials = Array.isArray(mrn.materials)
      ? mrn.materials.map(normalizeMaterial)
      : [];

    const normalizedMrn = {
      ...mrn,
      department: normalizeDepartmentName(mrn.department || ''),
      approvalLevel: mrn.approvalLevel === 1 ? 1 : mrn.approvalLevel === 2 ? 2 : 0,
      issueHoldReason: String(mrn.issueHoldReason || '').trim(),
      issueHoldBy: String(mrn.issueHoldBy || '').trim(),
      issueHoldAt: String(mrn.issueHoldAt || '').trim(),
      materials: normalizedMaterials,
      grnNumber: String(mrn.grnNumber || '').trim() || summarizeGrnNumbers(normalizedMaterials),
    };

    return {
      ...normalizedMrn,
      status: deriveMRNStatus(normalizedMrn),
    };
    }),
    legacyIdMap,
  };
};

const hydrateStateFromDatabase = async () => {
  users = await loadCollection('users', seededUsers);
  mrns = await loadCollection('mrns', seededMrns);
  notifications = await loadCollection('notifications', seededNotifications);
  historyRecords = await loadCollection('historyRecords', seededHistoryRecords);

  users = Array.isArray(users) ? normalizeStoredUsers(users) : normalizeStoredUsers(seededUsers);
  notifications = Array.isArray(notifications) ? notifications : structuredClone(seededNotifications);
  const normalizedMrnPayload = Array.isArray(mrns) ? normalizeMRNs(mrns) : normalizeMRNs(seededMrns);
  mrns = normalizedMrnPayload.mrns;
  historyRecords = Array.isArray(historyRecords)
    ? normalizeHistoryRecords(historyRecords).map((record) => ({
        ...record,
        documentId: normalizedMrnPayload.legacyIdMap.get(record.documentId) || record.documentId,
        summary: String(record.summary || '').replace(record.documentId, normalizedMrnPayload.legacyIdMap.get(record.documentId) || record.documentId),
      }))
    : structuredClone(seededHistoryRecords);

  ensureBootstrapAdmins();
  await Promise.all([
    saveUsers(),
    saveMrns(),
    saveNotifications(),
    saveHistoryRecords(),
  ]);
};

const validateRuntimeConfig = () => {
  const missing = [];

  if (!JWT_SECRET) {
    missing.push('JWT_SECRET');
  }

  if (IS_PRODUCTION && !ADMIN_PASSWORD) {
    missing.push('ADMIN_PASSWORD');
  }

  const hasAnySecondaryAdminValue = [
    SECONDARY_ADMIN_NAME,
    SECONDARY_ADMIN_EMAIL,
    SECONDARY_ADMIN_EMPLOYEE_CODE,
    SECONDARY_ADMIN_PASSWORD,
  ].some(Boolean);
  const hasCompleteSecondaryAdminConfig =
    Boolean(SECONDARY_ADMIN_EMAIL && SECONDARY_ADMIN_EMPLOYEE_CODE && SECONDARY_ADMIN_PASSWORD);

  if (hasAnySecondaryAdminValue && !hasCompleteSecondaryAdminConfig) {
    missing.push('SECONDARY_ADMIN_EMAIL, SECONDARY_ADMIN_EMPLOYEE_CODE, SECONDARY_ADMIN_PASSWORD');
  }

  if (IS_PRODUCTION && CORS_ORIGINS.length === 0) {
    missing.push('CORS_ORIGINS');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  }
};

const sendMailMessage = async ({ to, subject, text, html, logLabel, attachments = [] }) => {
  if (mailTransporterMode === 'brevo-api') {
    try {
      const info = await sendViaBrevoApi({ to, subject, text, html, attachments });
      console.log(`${logLabel} email handled via ${mailTransporterName} for ${to}`);
      return {
        status: 'sent',
        transport: mailTransporterName,
        message: 'Email sent successfully.',
        previewUrl: null,
        messageId:
          typeof info === 'object' && info && 'messageId' in info
            ? String(info.messageId || '')
            : null,
      };
    } catch (error) {
      console.error(`Failed to send ${logLabel.toLowerCase()} email:`, error);
      return {
        status: 'failed',
        transport: mailTransporterName,
        message: error instanceof Error ? error.message : 'Unknown email error',
        previewUrl: null,
      };
    }
  }

  if (!mailTransporter) {
    console.log(`Mail transport is not configured. ${logLabel} email content:`);
    console.log(text);
    return {
      status: 'logged',
      transport: mailTransporterName,
      message: 'Mail transport is not configured. Message content was logged on the backend.',
      previewUrl: null,
    };
  }

  try {
    const info = await mailTransporter.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text,
      html,
      attachments,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`${logLabel} email preview: ${previewUrl}`);
    }

    if (mailTransporterMode === 'stream' && info?.message) {
      console.log(`${logLabel} email stream output:\n${String(info.message)}`);
    }

    console.log(`${logLabel} email handled via ${mailTransporterName} for ${to}`);

    if (previewUrl) {
      return {
        status: 'preview',
        transport: mailTransporterName,
        message: 'Email was generated in preview mode. Check backend logs for the preview URL.',
        previewUrl,
      };
    }

    if (mailTransporterMode === 'stream') {
      return {
        status: 'logged',
        transport: mailTransporterName,
        message: 'Email was captured by the local development mail stream and written to backend logs.',
        previewUrl: null,
      };
    }

    return {
      status: 'sent',
      transport: mailTransporterName,
      message: 'Email sent successfully.',
      previewUrl: null,
    };
  } catch (error) {
    console.error(`Failed to send ${logLabel.toLowerCase()} email:`, error);
    return {
      status: 'failed',
      transport: mailTransporterName,
      message: error instanceof Error ? error.message : 'Unknown email error',
      previewUrl: null,
    };
  }
};

const sendWelcomeEmail = async (user, tempPassword) => {
  const text = `Hello ${user.name},

Welcome to TASE Digital MRS.

Your workspace is ready. Use the credentials below to sign in:

Employee Code: ${user.employeeCode}
Temporary Password: ${tempPassword}
Registered Email: ${user.email}
Role: ${user.role}
Department: ${user.department}

Access your app: ${FRONTEND_URL}

Please sign in using your employee code and temporary password, then change your password after your first login.

Regards,
MRS System Admin`;

  const html = buildEmailShell({
    preheader: `Welcome to TASE Digital MRS. Your account is ready and your sign-in details are inside.`,
    title: 'Welcome to TASE Digital MRS',
    intro: 'Your workspace has been created successfully. Review your credentials below and access the application in one click.',
    buttonLabel: 'Access Your App',
    buttonUrl: FRONTEND_URL,
    bodyHtml: `
      <p style="margin: 0 0 12px; font-size: 14px; line-height: 20px; letter-spacing: 0.08em; text-transform: uppercase; color: #3c0e79; font-weight: 700;">
        Welcome Greeting
      </p>
      <p style="margin: 0 0 12px; font-size: 24px; line-height: 32px; color: #0f172a; font-weight: 700;">
        Hello ${escapeHtml(user.name)},
      </p>
      <p style="margin: 0 0 24px; font-size: 15px; line-height: 24px; color: #475569;">
        Your TASE Digital MRS account is active and ready to use. We have prepared your login credentials below so you can access the application right away.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px; border-radius: 22px; background: linear-gradient(180deg, #faf6ff 0%, #f5f0fb 100%); border: 1px solid #e9d5ff;">
        <tr>
          <td style="padding: 22px 22px 18px;">
            <p style="margin: 0 0 16px; font-size: 13px; line-height: 18px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; font-weight: 700;">
              Credential Details
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
              <tr>
                <td style="padding: 0 0 14px; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280;">Employee Code</td>
                <td style="padding: 0 0 14px; font-size: 15px; line-height: 20px; font-weight: 700; color: #0f172a;" align="right">${escapeHtml(user.employeeCode)}</td>
              </tr>
              <tr>
                <td style="padding: 14px 0; border-top: 1px solid #e9d5ff; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280;">Temporary Password</td>
                <td style="padding: 14px 0; border-top: 1px solid #e9d5ff; font-size: 15px; line-height: 20px; font-weight: 700; color: #3c0e79;" align="right">${escapeHtml(tempPassword)}</td>
              </tr>
              <tr>
                <td style="padding: 14px 0; border-top: 1px solid #e9d5ff; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280;">Email</td>
                <td style="padding: 14px 0; border-top: 1px solid #e9d5ff; font-size: 15px; line-height: 20px; color: #0f172a;" align="right">${escapeHtml(user.email)}</td>
              </tr>
              <tr>
                <td style="padding: 14px 0; border-top: 1px solid #e9d5ff; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280;">Role</td>
                <td style="padding: 14px 0; border-top: 1px solid #e9d5ff; font-size: 15px; line-height: 20px; color: #0f172a;" align="right">${escapeHtml(user.role)}</td>
              </tr>
              <tr>
                <td style="padding: 14px 0 0; border-top: 1px solid #e9d5ff; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280;">Department</td>
                <td style="padding: 14px 0 0; border-top: 1px solid #e9d5ff; font-size: 15px; line-height: 20px; color: #0f172a;" align="right">${escapeHtml(user.department)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px; border-radius: 20px; background: linear-gradient(135deg, #2b0a58 0%, #3c0e79 100%);">
        <tr>
          <td style="padding: 20px 22px;">
            <p style="margin: 0 0 8px; font-size: 13px; line-height: 18px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(233, 213, 255, 0.95); font-weight: 700;">
              Access Your App
            </p>
            <p style="margin: 0 0 10px; font-size: 15px; line-height: 24px; color: rgba(255, 255, 255, 0.9);">
              Use the button below to open the TASE Digital MRS portal and sign in with the credentials above.
            </p>
            <p style="margin: 0; font-size: 13px; line-height: 22px; word-break: break-all;">
              <a href="${escapeHtml(FRONTEND_URL)}" style="color: #e9d5ff; text-decoration: none;">${escapeHtml(FRONTEND_URL)}</a>
            </p>
          </td>
        </tr>
      </table>

      <div style="margin: 0 0 22px; padding: 16px 18px; border-radius: 18px; background-color: #f5f0fb; border: 1px solid #d8b4fe;">
        <p style="margin: 0; font-size: 13px; line-height: 22px; color: #3c0e79;">
          For security, please change your temporary password immediately after your first login.
        </p>
      </div>
      <p style="margin: 0; font-size: 14px; line-height: 22px; color: #475569;">Regards,<br />MRS System Admin</p>
    `,
  });

  return sendMailMessage({
    to: user.email,
    subject: 'Welcome to TASE Digital MRS',
    text,
    html,
    logLabel: 'Welcome',
    attachments: getEmailLogoAttachments(),
  });
};

const sendRequesterContactEmail = async ({ requester, mrn, sender, message }) => {
  const text = `Hello ${requester.name},

The issuing team requested that you review MRS ${mrn.id}.

Message from ${sender.name}:
${message}

Current MRS status: ${mrn.status}
Department: ${mrn.department}
Access your app: ${FRONTEND_URL}

Regards,
MRS System`;

  const html = buildEmailShell({
    preheader: `${sender.name} asked you to review ${mrn.id}.`,
    title: `Action needed for ${mrn.id}`,
    intro: 'The issuing team needs your attention on an MRS request. Review the message below and continue in the app.',
    buttonLabel: 'Access your app',
    buttonUrl: FRONTEND_URL,
    bodyHtml: `
      <p style="margin: 0 0 14px; font-size: 16px; line-height: 26px;">Hello <strong>${escapeHtml(requester.name)}</strong>,</p>
      <p style="margin: 0 0 22px; font-size: 15px; line-height: 24px; color: #334155;">
        <strong>${escapeHtml(sender.name)}</strong> requested that you review <strong>${escapeHtml(mrn.id)}</strong>.
      </p>
      <div style="margin: 0 0 22px; padding: 18px 20px; border: 1px solid #dbeafe; border-radius: 20px; background-color: #f8fbff;">
        <p style="margin: 0 0 10px; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b;">Message from ${escapeHtml(sender.name)}</p>
        <p style="margin: 0; font-size: 15px; line-height: 24px; color: #0f172a;">${nl2br(message)}</p>
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 22px; border: 1px solid #e2e8f0; border-radius: 18px;">
        <tr>
          <td style="padding: 16px 18px; font-size: 14px; line-height: 22px; color: #475569;">
            <strong style="display: block; color: #0f172a;">Current status</strong>
            ${escapeHtml(mrn.status)}
          </td>
        </tr>
        <tr>
          <td style="padding: 0 18px 16px; font-size: 14px; line-height: 22px; color: #475569;">
            <strong style="display: block; color: #0f172a;">Department</strong>
            ${escapeHtml(mrn.department)}
          </td>
        </tr>
      </table>
      <p style="margin: 0; font-size: 14px; line-height: 22px; color: #475569;">Regards,<br />MRS System</p>
    `,
  });

  return sendMailMessage({
    to: requester.email,
    subject: `Action requested for ${mrn.id}`,
    text,
    html,
    logLabel: 'Requester contact',
    attachments: getEmailLogoAttachments(),
  });
};

app.post('/api/auth/login', (req, res) => {
  const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
  const normalizedEmployeeCode = normalizeEmployeeCode(req.body?.employeeCode);
  const password = String(req.body?.password || '');

  if ((!normalizedEmail && !normalizedEmployeeCode) || !password) {
    return res.status(400).json({ message: 'Email or employee code and password are required' });
  }

  const user = normalizedEmail
    ? users.find((item) => item.email.toLowerCase() === normalizedEmail)
    : findUserByEmployeeCode(normalizedEmployeeCode);

  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (user.status !== 'Active') {
    return res.status(403).json({ message: 'Your account is inactive. Please contact an administrator.' });
  }

  if (user.mustChangePassword) {
    const setupToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        employeeCode: user.employeeCode,
        purpose: 'password_setup',
      },
      JWT_SECRET,
      { expiresIn: PASSWORD_SETUP_EXPIRY }
    );

    return res.json({
      requiresPasswordSetup: true,
      setupToken,
      user: publicUser(user),
    });
  }

  user.lastActive = new Date().toISOString();
  saveUsers();

  const token = jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      employeeCode: user.employeeCode,
    },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  return res.json({
    token,
    user: publicUser(user),
  });
});

app.post('/api/auth/setup-password', (req, res) => {
  const setupToken = String(req.body?.setupToken || '');
  const newPassword = String(req.body?.newPassword || '');
  const confirmPassword = String(req.body?.confirmPassword || '');

  if (!setupToken) {
    return res.status(400).json({ message: 'Password setup token is required' });
  }

  const passwordError = validateNewPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ message: 'Passwords do not match' });
  }

  let payload;
  try {
    payload = jwt.verify(setupToken, JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ message: 'Password setup session expired. Please sign in again.' });
  }

  if (!payload || payload.purpose !== 'password_setup' || !payload.id) {
    return res.status(401).json({ message: 'Invalid password setup request' });
  }

  const user = users.find((item) => item.id === payload.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  user.password = hashPassword(newPassword);
  user.mustChangePassword = false;
  user.lastActive = new Date().toISOString();
  saveUsers();

  const token = jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      employeeCode: user.employeeCode,
    },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  return res.json({
    token,
    user: publicUser(user),
  });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  return res.json(publicUser(user));
});

app.get('/api/mrns', authenticate, (req, res) => {
  const user = users.find((item) => item.id === req.user.id) || req.user;
  return res.json(getVisibleMRNs(user));
});

app.get('/api/mrns/:id', authenticate, (req, res) => {
  const user = users.find((item) => item.id === req.user.id) || req.user;
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRS not found' });
  if (!canReadMRS(user, mrn)) {
    return res.status(403).json({ message: 'You are not allowed to access this MRS' });
  }
  return res.json(mrn);
});

app.get('/api/notifications', authenticate, (req, res) => {
  return res.json(
    notifications
      .filter((notification) => notification.userId === req.user.id)
      .map(({ userId, ...notification }) => notification)
  );
});

app.post('/api/notifications/mark-all-read', authenticate, (req, res) => {
  notifications.forEach((notification) => {
    if (notification.userId === req.user.id) {
      notification.read = true;
    }
  });
  saveNotifications();

  return res.json(
    notifications
      .filter((notification) => notification.userId === req.user.id)
      .map(({ userId, ...notification }) => notification)
  );
});

app.post('/api/notifications/:id/read', authenticate, (req, res) => {
  const notification = notifications.find(
    (item) => item.id === req.params.id && item.userId === req.user.id
  );
  if (!notification) return res.status(404).json({ message: 'Notification not found' });

  notification.read = true;
  saveNotifications();
  const { userId, ...publicNotification } = notification;
  return res.json(publicNotification);
});

app.post('/api/mrns', authenticate, (req, res) => {
  const user = users.find((u) => u.id === req.user.id);
  const { priority, materials, purpose } = req.body;

  if (!canCreateMRS(user)) {
    return res.status(403).json({ message: 'Action not allowed for your role' });
  }

  if (!materials || !Array.isArray(materials) || materials.length === 0) {
    return res.status(400).json({ message: 'Materials are required' });
  }

  const currentYear = new Date().getFullYear();
  const currentYearMaxCount = mrns.reduce((maxCount, item) => {
    const match = String(item.id || '').match(new RegExp(`^MRS/${currentYear}/(\\d{4})$`));
    if (!match) {
      return maxCount;
    }

    return Math.max(maxCount, Number(match[1]));
  }, 0);
  const id = formatMRSId(currentYear, currentYearMaxCount + 1);
  const now = new Date().toISOString().slice(0, 10);
  const newMrn = {
    id,
    date: now,
    requester: user.name,
    department: normalizeDepartmentName(user.department),
    approvalLevel: 0,
    issueHoldReason: '',
    issueHoldBy: '',
    issueHoldAt: '',
    status: 'Submitted',
    slaStatus: 'on-time',
    slaHoursLeft: 96,
    priority: priority || 'Medium',
    purpose: String(purpose || '').trim(),
    materials: materials.map((item, index) => ({
      id: `m-${Date.now()}-${index}`,
      materialCode: String(item.materialCode || '').trim(),
      description: String(item.description || '').trim(),
      spec: String(item.spec || '').trim(),
      uom: String(item.uom || 'PCS').trim(),
      requestedQty: sanitizeQty(item.requestedQty ?? item.qty),
      issuedQty: 0,
      returnedQty: 0,
      grnNumber: '',
      approvalStatus: 'Pending',
      status: 'Pending',
    })),
    comments: [
      {
        id: `c-${Date.now()}`,
        author: user.name,
        role: user.role,
        message: 'MRS created',
        timestamp: new Date().toISOString(),
        avatar: user.avatar,
      },
    ],
    timeline: [
      {
        id: `t-${Date.now()}`,
        label: 'MRS created',
        status: 'completed',
        timestamp: new Date().toISOString(),
        actor: user.name,
      },
      {
        id: `t-${Date.now() + 1}`,
        label: 'Pending L1 approval',
        status: 'active',
      },
    ],
  };

  mrns.unshift(newMrn);
  saveMrns();
  pushHistoryRecord({
    action: 'create',
    actor: user.name,
    actorRole: user.role,
    mrn: newMrn,
    summary: `${newMrn.id} created with ${newMrn.materials.length} material line(s).`,
  });
  return res.status(201).json(newMrn);
});

app.put('/api/mrns/:id', authenticate, (req, res) => {
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRS not found' });

  const user = users.find((item) => item.id === req.user.id) || req.user;
  if (!canCreateMRS(user) && user.role !== 'Admin') {
    return res.status(403).json({ message: 'Action not allowed for your role' });
  }

  if (!canManageMrn(mrn, user)) {
    return res.status(403).json({ message: 'You are not allowed to edit this MRS' });
  }

  if (isClosedMrnStatus(mrn.status) && user.role !== 'Admin') {
    return res.status(403).json({ message: 'Closed MRS documents can only be edited by Admin' });
  }

  const { priority, materials, purpose } = req.body || {};

  if (!materials || !Array.isArray(materials) || materials.length === 0) {
    return res.status(400).json({ message: 'Materials are required' });
  }

  try {
    mrn.priority = priority || mrn.priority || 'Medium';
    mrn.purpose = String(purpose || '').trim();
    mrn.materials = buildMrnMaterials(materials, mrn.materials);
    mrn.grnNumber = summarizeGrnNumbers(mrn.materials);
    mrn.status = deriveMRNStatus(mrn);

    const actor = user.name || user.email;
    const now = new Date().toISOString();
    mrn.comments.push({
      id: `c-${Date.now()}`,
      author: actor,
      role: user.role,
      message: 'MRS details updated',
      timestamp: now,
      avatar: user.name ? buildAvatar(user.name) : '??',
    });
    mrn.timeline.push({
      id: `t-${Date.now()}`,
      label: 'MRS updated',
      status: 'completed',
      timestamp: now,
      actor,
      note: user.role === 'Admin' ? 'Updated by admin' : 'Updated by requester-side user before approval',
    });

    saveMrns();
    pushHistoryRecord({
      action: 'update',
      actor,
      actorRole: user.role,
      mrn,
      summary: `${mrn.id} updated before workflow completion.`,
    });
    return res.json(mrn);
  } catch (error) {
    return res.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to update MRS',
    });
  }
});

app.delete('/api/mrns/:id', authenticate, (req, res) => {
  const user = users.find((item) => item.id === req.user.id) || req.user;
  if (!canCreateMRS(user) && user.role !== 'Admin') {
    return res.status(403).json({ message: 'Action not allowed for your role' });
  }

  const mrnIndex = mrns.findIndex((item) => item.id === req.params.id);
  if (mrnIndex === -1) return res.status(404).json({ message: 'MRS not found' });

  const mrn = mrns[mrnIndex];
  if (!canManageMrn(mrn, user)) {
    return res.status(403).json({ message: 'You are not allowed to delete this MRS' });
  }

  if (isClosedMrnStatus(mrn.status) && user.role !== 'Admin') {
    return res.status(403).json({ message: 'Closed MRS documents can only be deleted by Admin' });
  }

  const [deletedMrn] = mrns.splice(mrnIndex, 1);
  notifications = notifications.filter((notification) => notification.mrnId !== deletedMrn.id);
  saveMrns();
  saveNotifications();
  pushHistoryRecord({
    action: 'delete',
    actor: user.name || user.email,
    actorRole: user.role,
    mrn: deletedMrn,
    summary: `${deletedMrn.id} deleted from the active register.`,
  });

  return res.json({ id: deletedMrn.id, deleted: true });
});

app.put('/api/mrns/:id/status', authenticate, (req, res) => {
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRS not found' });

  const { action, comment, grnNumber, materials } = req.body;
  const role = req.user.role;
  const previousStatus = mrn.status;
  const currentUser = users.find((item) => item.id === req.user.id) || req.user;

  const transitionMap = {
    approve: ['L1 Approver', 'L2 Approver', 'Admin'],
    reject: ['L1 Approver', 'L2 Approver', 'Admin'],
    hold: ['L1 Approver', 'L2 Approver', 'Admin'],
    issue: ['Issuer', 'Admin'],
    issuer_hold: ['Issuer', 'Admin'],
    return: ['Requester', 'L1 Approver', 'L2 Approver', 'Issuer', 'Admin'],
    not_available: ['Issuer', 'Admin'],
  };

  if (!action || !transitionMap[action]) {
    return res.status(400).json({ message: 'Invalid action' });
  }

  if (!transitionMap[action].includes(role)) {
    return res.status(403).json({ message: 'Action not allowed for your role' });
  }

  if (APPROVER_WORKFLOW_ACTIONS.has(action)) {
    if (role === 'L1 Approver' && !canApproveAsL1(currentUser, mrn)) {
      return res.status(403).json({ message: 'L1 approval is restricted to the requester department manager.' });
    }

    if (role === 'L1 Approver' && mrn.approvalLevel !== 0) {
      return res.status(409).json({ message: 'L1 actions are available only before L1 approval is completed.' });
    }

    if (role === 'L2 Approver') {
      if (!canApproveAsL2(currentUser)) {
        return res.status(403).json({ message: 'L2 approval is restricted to the Purchase Manager.' });
      }

      if (mrn.approvalLevel !== 1) {
        return res.status(409).json({ message: 'L2 actions are available only after L1 approval is completed.' });
      }
    }
  }

  if (action === 'return' && !canReturnMRS(currentUser, mrn)) {
    return res.status(403).json({ message: 'Only the requester who created this MRS can record returns.' });
  }

  const allowedActions = transitionRules[mrn.status] || [];
  if (!allowedActions.includes(action)) {
    return res.status(409).json({ message: `Cannot ${action.replace('_', ' ')} when MRS is ${mrn.status}` });
  }
  const now = new Date().toISOString();
  const actor = req.user.name || req.user.email;
  const nextStatus = {
    approve: 'Approved',
    reject: 'Rejected',
    hold: 'Hold',
    not_available: 'Not Available',
  }[action];

  if (action === 'issue') {
    if (!Array.isArray(materials) || materials.length === 0) {
      return res.status(400).json({ message: 'Issued quantity details are required' });
    }

    const materialUpdates = new Map(
      materials.map((item) => [
        String(item.id),
        {
          issuedQty: sanitizeQty(item.issuedQty),
          grnNumber: String(item.grnNumber || '').trim(),
        },
      ])
    );

    let hasIssuedQty = false;
    let issueValidationError = '';

    mrn.materials = mrn.materials.map((item) => {
      const requestedQty = getRequestedQty(item);
      const currentIssuedQty = getIssuedQty(item);
      const currentReturnedQty = getReturnedQty(item);
      const update = materialUpdates.get(item.id) || {
        issuedQty: currentIssuedQty,
        grnNumber: String(item.grnNumber || '').trim(),
      };
      const issuedQty = Math.min(update.issuedQty, requestedQty);
      const materialGrnNumber = update.grnNumber || String(item.grnNumber || '').trim();

      if (issuedQty < currentIssuedQty) {
        issueValidationError = `Issued quantity cannot be reduced for ${item.materialCode}`;
        return item;
      }

      if (issuedQty > 0 && !materialGrnNumber) {
        issueValidationError = `GRN number is required for ${item.materialCode} when issue quantity is greater than 0`;
        return item;
      }

      if (currentReturnedQty > issuedQty) {
        issueValidationError = `Issued quantity cannot be lower than returned quantity for ${item.materialCode}`;
        return item;
      }

      const returnedQty = Math.min(getReturnedQty(item), issuedQty);
      const nextItem = normalizeMaterial({
        ...item,
        requestedQty,
        issuedQty,
        returnedQty,
        grnNumber: issuedQty > 0 ? materialGrnNumber : '',
        approvalStatus: 'Approved',
      });

      if (issuedQty > 0) {
        hasIssuedQty = true;
      }

      return nextItem;
    });

    if (issueValidationError) {
      return res.status(400).json({ message: issueValidationError });
    }

    if (!hasIssuedQty) {
      return res.status(400).json({ message: 'At least one material must have an issued quantity greater than 0' });
    }

    mrn.issueHoldReason = '';
    mrn.issueHoldBy = '';
    mrn.issueHoldAt = '';
    mrn.grnNumber = summarizeGrnNumbers(mrn.materials) || String(grnNumber || '').trim();
    mrn.status = deriveMRNStatus(mrn);
    completeActiveTimelineSteps(mrn);
    mrn.timeline.push({
      id: `t-${Date.now()}`,
      label: mrn.status === 'Partially Issued' ? 'Partial issue recorded' : 'Issued',
      status: 'completed',
      timestamp: now,
      actor,
      note: `${comment || 'Material issue updated'} (GRN: ${mrn.grnNumber})`,
    });

    if (mrn.status === 'Partially Issued') {
      mrn.timeline.push({
        id: `t-${Date.now() + 1}`,
        label: 'Awaiting remaining issue',
        status: 'active',
      });
    }
  } else if (action === 'issuer_hold') {
    const holdReason = String(comment || '').trim();
    if (!holdReason) {
      return res.status(400).json({ message: 'Hold reason is required' });
    }

    mrn.issueHoldReason = holdReason;
    mrn.issueHoldBy = actor;
    mrn.issueHoldAt = now;
    mrn.timeline.push({
      id: `t-${Date.now()}`,
      label: 'Issuer hold recorded',
      status: 'completed',
      timestamp: now,
      actor,
      note: holdReason,
    });
  } else if (action === 'return') {
    if (!Array.isArray(materials) || materials.length === 0) {
      return res.status(400).json({ message: 'Return quantity details are required' });
    }

    const returnUpdates = new Map(
      materials.map((item) => [String(item.id), sanitizeQty(item.returnQty)])
    );

    let hasReturnQty = false;
    let returnValidationError = '';

    mrn.materials = mrn.materials.map((item) => {
      const requestedQty = getRequestedQty(item);
      const issuedQty = getIssuedQty(item);
      const currentReturnedQty = getReturnedQty(item);
      const nextReturnQty = returnUpdates.get(item.id) ?? 0;
      const maxReturnableQty = Math.max(issuedQty - currentReturnedQty, 0);

      if (nextReturnQty > maxReturnableQty) {
        returnValidationError = `Return quantity cannot exceed issued quantity for ${item.materialCode}`;
        return item;
      }

      const returnedQty = currentReturnedQty + nextReturnQty;
      const nextItem = normalizeMaterial({
        ...item,
        requestedQty,
        issuedQty,
        returnedQty,
        approvalStatus: 'Approved',
      });

      if (nextReturnQty > 0) {
        hasReturnQty = true;
      }

      return nextItem;
    });

    if (returnValidationError) {
      return res.status(400).json({ message: returnValidationError });
    }

    if (!hasReturnQty) {
      return res.status(400).json({ message: 'At least one material must have a return quantity greater than 0' });
    }

    mrn.issueHoldReason = '';
    mrn.issueHoldBy = '';
    mrn.issueHoldAt = '';
    mrn.status = deriveMRNStatus(mrn);
    mrn.grnNumber = summarizeGrnNumbers(mrn.materials);
    completeActiveTimelineSteps(mrn);
    mrn.timeline.push({
      id: `t-${Date.now()}`,
      label: 'Return recorded',
      status: 'completed',
      timestamp: now,
      actor,
      note: comment || 'Returned quantities were recorded against this MRS.',
    });
  } else {
    if (action === 'approve') {
      if (role === 'L1 Approver' && mrn.approvalLevel === 0) {
        mrn.approvalLevel = 1;
        mrn.status = 'Submitted';
      } else {
        mrn.approvalLevel = 2;
        mrn.status = 'Approved';
      }
    } else {
      mrn.status = nextStatus;
    }

    completeActiveTimelineSteps(mrn);

    if (action === 'not_available') {
      mrn.materials = mrn.materials.map((item) => ({
        ...normalizeMaterial({
          ...item,
          issuedQty: 0,
          returnedQty: 0,
          grnNumber: '',
          approvalStatus: 'Approved',
          status: 'Not Available',
        }),
        approvalStatus: 'Approved',
        status: 'Not Available',
      }));
      mrn.issueHoldReason = '';
      mrn.issueHoldBy = '';
      mrn.issueHoldAt = '';
      mrn.grnNumber = '';
    } else {
      const materialApprovalStatus = getMaterialApprovalStatusByMrnStatus(mrn.status);
      mrn.materials = mrn.materials.map((item) =>
        normalizeMaterial({
          ...item,
          approvalStatus: materialApprovalStatus,
        })
      );
    }

    mrn.timeline.push({
      id: `t-${Date.now()}`,
      label: `${action.replace('_', ' ')} action`,
      status: 'completed',
      timestamp: now,
      actor,
      note: comment || '',
    });

    if (action === 'approve') {
      if (mrn.approvalLevel === 1) {
        mrn.timeline.push({
          id: `t-${Date.now() + 1}`,
          label: 'Pending L2 approval',
          status: 'active',
        });
      } else {
        mrn.timeline.push({
          id: `t-${Date.now() + 1}`,
          label: 'Ready for issue',
          status: 'active',
        });
      }
    }
  }

  mrn.comments.push({
    id: `c-${Date.now()}`,
    author: actor,
    role,
    message:
      action === 'issue' && mrn.grnNumber
        ? `${comment || `${role} executed ${action}`} (GRN: ${mrn.grnNumber})`
        : action === 'issuer_hold'
          ? `Issuer hold recorded: ${comment || ''}`
        : comment || `${role} executed ${action.replace('_', ' ')}`,
    timestamp: now,
    avatar: req.user.name ? buildAvatar(req.user.name) : '??',
  });

  if (!isClosedMrnStatus(previousStatus) && isClosedMrnStatus(mrn.status)) {
    notifyClosedMrn({ mrn, actor, action });
  }

  saveMrns();
  pushHistoryRecord({
    action: 'status_change',
    actor,
    actorRole: role,
    mrn,
    summary:
      action === 'issue'
        ? `${mrn.id} issue quantities updated.`
        : action === 'return'
          ? `${mrn.id} return quantities updated.`
          : `${mrn.id} workflow action recorded: ${action.replace('_', ' ')}.`,
  });
  return res.json(mrn);
});

app.post('/api/mrns/:id/contact-requester', authenticate, authorize(['Issuer', 'Admin']), async (req, res) => {
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRS not found' });

  const requester = getRequesterUser(mrn);
  if (!requester) {
    return res.status(404).json({ message: 'Requester account not found for this MRS' });
  }

  const message = String(req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ message: 'Message is required' });
  }

  const sender = users.find((user) => user.id === req.user.id);
  const senderName = sender?.name || req.user.name || req.user.email;
  const now = new Date().toISOString();

  mrn.comments.push({
    id: `c-${Date.now()}`,
    author: senderName,
    role: req.user.role,
    message: `Requester contacted: ${message}`,
    timestamp: now,
    avatar: sender?.avatar || buildAvatar(senderName),
  });

  mrn.timeline.push({
    id: `t-${Date.now()}`,
    label: 'Requester contacted',
    status: 'completed',
    timestamp: now,
    actor: senderName,
    note: message,
  });

  pushNotification({
    userId: requester.id,
    title: `Issuer contacted you about ${mrn.id}`,
    message,
    type: 'call',
    mrnId: mrn.id,
  });

  const emailDelivery = await sendRequesterContactEmail({
    requester,
    mrn,
    sender: sender || { name: senderName },
    message,
  });

  saveMrns();
  pushHistoryRecord({
    action: 'comment',
    actor: senderName,
    actorRole: req.user.role,
    mrn,
    summary: `${mrn.id} requester contact message recorded.`,
  });
  return res.json({
    ...mrn,
    emailDelivery,
  });
});

app.post('/api/mrns/:id/comments', authenticate, (req, res) => {
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRS not found' });

  const message = String(req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ message: 'Comment message is required' });
  }

  const author = req.user.name || req.user.email;
  mrn.comments.push({
    id: `c-${Date.now()}`,
    author,
    role: req.user.role,
    message,
    timestamp: new Date().toISOString(),
    avatar: req.user.name ? buildAvatar(req.user.name) : '??',
  });

  saveMrns();
  pushHistoryRecord({
    action: 'comment',
    actor: author,
    actorRole: req.user.role,
    mrn,
    summary: `${mrn.id} comment added.`,
  });
  return res.status(201).json(mrn);
});

app.get('/api/history', authenticate, (req, res) => {
  const user = users.find((item) => item.id === req.user.id) || req.user;
  if (!(user.role === 'Admin' || user.role === 'Management' || isQmsDepartment(user.department))) {
    return res.status(403).json({ message: 'History access is restricted to Admin and QMS users' });
  }

  return res.json(historyRecords);
});

app.post('/api/pdf/export', authenticate, async (req, res) => {
  const {
    html,
    styles = '',
    filename = 'document.pdf',
    title = 'Document',
    pageFormat = 'a4',
    orientation = 'portrait',
    margin = 5,
    baseUrl = '',
  } = req.body || {};

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ message: 'HTML content is required for PDF export' });
  }

  try {
    const pdfBytes = await generatePdfBuffer({
      html,
      styles: typeof styles === 'string' ? styles : '',
      title: typeof title === 'string' ? title : 'Document',
      pageFormat: typeof pageFormat === 'string' ? pageFormat.toLowerCase() : 'a4',
      orientation: orientation === 'landscape' ? 'landscape' : 'portrait',
      margin: Number.isFinite(Number(margin)) ? Number(margin) : 0,
      baseUrl: typeof baseUrl === 'string' ? baseUrl : '',
    });
    const pdfBuffer = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(String(filename))}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('PDF export failed:', error);
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Unable to generate PDF',
    });
  }
});

app.get('/api/users', authenticate, (req, res) => {
  const user = users.find((item) => item.id === req.user.id) || req.user;
  if (!hasSystemAdminAccess(user)) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }
  return res.json(users.map(publicUser));
});

app.post('/api/users', authenticate, async (req, res) => {
  const user = users.find((item) => item.id === req.user.id) || req.user;
  if (!hasSystemAdminAccess(user)) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const { name, email, role, department, employeeCode, designation, team, status } = req.body;
  const normalizedEmail = String(email || '').toLowerCase().trim();
  const normalizedEmployeeCode = normalizeEmployeeCode(employeeCode);
  const normalizedDepartment = normalizeDepartmentName(department);
  const resolvedTeam = resolveUserTeam(normalizedDepartment, team);

  if (!name || !email || !role || !normalizedDepartment || !employeeCode || !designation) {
    return res.status(400).json({ message: 'All user fields are required' });
  }
  if (departmentRequiresTeam(normalizedDepartment) && !resolvedTeam) {
    return res.status(400).json({ message: 'A valid team is required for the selected department' });
  }

  const existingEmailUser = users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (existingEmailUser) {
    return res.status(409).json({ message: 'A user already exists with that email' });
  }
  if (findUserByEmployeeCode(normalizedEmployeeCode)) {
    return res.status(409).json({ message: 'A user already exists with that employee code' });
  }

  const tempPassword = `Password${normalizedEmployeeCode}`;
  const id = `u_${normalizedEmployeeCode.toLowerCase()}`;
  const avatar = buildAvatar(name);
  const newUser = {
    id,
    name: String(name).trim(),
    email: normalizedEmail,
    password: hashPassword(tempPassword),
    mustChangePassword: true,
    role: String(role).trim(),
    department: normalizedDepartment,
    employeeCode: normalizedEmployeeCode,
    designation: String(designation).trim(),
    team: resolvedTeam,
    status: status === 'Inactive' ? 'Inactive' : 'Active',
    avatar,
    lastActive: new Date().toISOString(),
  };

  users.push(newUser);
  saveUsers();

  let welcomeEmailDelivery;
  try {
    welcomeEmailDelivery = await sendWelcomeEmail(newUser, tempPassword);
  } catch (error) {
    console.error('Failed to send onboarding email:', error);
    welcomeEmailDelivery = {
      status: 'failed',
      transport: mailTransporterName,
      message: error instanceof Error ? error.message : 'Unknown email error',
      previewUrl: null,
    };
  }

  return res.status(201).json({
    ...publicUser(newUser),
    welcomeEmailDelivery,
    ...(welcomeEmailDelivery?.status === 'sent' ? {} : { temporaryPassword: tempPassword }),
  });
});

app.put('/api/users/:id', authenticate, (req, res) => {
  const currentActor = users.find((item) => item.id === req.user.id) || req.user;
  if (!hasSystemAdminAccess(currentActor)) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const { name, role, department, status, employeeCode, designation, team } = req.body;
  const normalizedEmployeeCode = employeeCode ? normalizeEmployeeCode(employeeCode) : '';
  const normalizedDepartment = department ? normalizeDepartmentName(department) : user.department;
  const resolvedTeam = resolveUserTeam(normalizedDepartment, team ?? user.team);
  const isAdminAccount = user.id === PRIMARY_ADMIN_ID;

  if (departmentRequiresTeam(normalizedDepartment) && !resolvedTeam) {
    return res.status(400).json({ message: 'A valid team is required for the selected department' });
  }

  if (isAdminAccount && role && String(role).trim() !== 'Admin') {
    return res.status(400).json({ message: 'The primary admin role cannot be changed' });
  }
  if (isAdminAccount && status && String(status).trim() !== 'Active') {
    return res.status(400).json({ message: 'The primary admin account must remain active' });
  }
  if (isAdminAccount && normalizedEmployeeCode && normalizedEmployeeCode !== ADMIN_EMPLOYEE_CODE) {
    return res.status(400).json({ message: 'The primary admin employee code cannot be changed' });
  }

  if (name) {
    user.name = String(name).trim();
    user.avatar = buildAvatar(user.name);
  }
  if (role) user.role = String(role).trim();
  if (department) user.department = normalizedDepartment;
  if (status) user.status = String(status).trim();
  if (normalizedEmployeeCode) {
    const existingEmployeeCodeUser = findUserByEmployeeCode(normalizedEmployeeCode);
    if (existingEmployeeCodeUser && existingEmployeeCodeUser.id !== user.id) {
      return res.status(409).json({ message: 'A user already exists with that employee code' });
    }
    user.employeeCode = normalizedEmployeeCode;
  }
  if (designation) user.designation = String(designation).trim();
  user.team = departmentRequiresTeam(user.department) ? resolvedTeam : '';

  saveUsers();
  return res.json(publicUser(user));
});

app.delete('/api/users/:id', authenticate, (req, res) => {
  const currentActor = users.find((item) => item.id === req.user.id) || req.user;
  if (!hasSystemAdminAccess(currentActor)) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }

  const userIndex = users.findIndex((u) => u.id === req.params.id);
  if (userIndex === -1) return res.status(404).json({ message: 'User not found' });

  if (users[userIndex].id === PRIMARY_ADMIN_ID) {
    return res.status(400).json({ message: 'The primary admin account cannot be removed' });
  }

  if (users[userIndex].id === req.user.id) {
    return res.status(400).json({ message: 'You cannot remove your own account' });
  }

  const [removedUser] = users.splice(userIndex, 1);
  saveUsers();
  return res.json(publicUser(removedUser));
});

// Password reset requests (admin approval workflow)
app.post('/api/password-reset-requests', (req, res) => {
  const { employeeCode, email, reason } = req.body || {};
  const normalizedCode = String(employeeCode || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!normalizedCode && !normalizedEmail) {
    return res.status(400).json({ message: 'Employee code or email is required' });
  }

  const id = `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const user = users.find((u) => (normalizedEmail && u.email === normalizedEmail) || (normalizedCode && u.employeeCode === normalizedCode));

  const record = {
    id,
    userId: user ? user.id : null,
    employeeCode: normalizedCode || null,
    email: normalizedEmail || null,
    reason: String(reason || '').trim(),
    status: 'PENDING',
    requestedAt: new Date().toISOString(),
    handledBy: null,
    handledAt: null,
    notes: null,
    token: null,
    tokenExpiresAt: null,
  };

  passwordResetRequests.push(record);

  // create in-app notification for admins
  notifications.push({ id: `n_${Date.now()}`, userId: user ? user.id : null, title: 'Password reset request', body: `Password reset requested for ${normalizedEmail || normalizedCode}`, createdAt: new Date().toISOString(), read: false });

  return res.status(201).json({ message: 'Request submitted', request: record });
});

app.get('/api/password-reset-requests', authenticate, authorize(['Admin']), (req, res) => {
  return res.json({ requests: passwordResetRequests });
});

app.post('/api/password-reset-requests/:id/approve', authenticate, authorize(['Admin']), (req, res) => {
  const id = req.params.id;
  const reqRecord = passwordResetRequests.find((r) => r.id === id);
  if (!reqRecord) return res.status(404).json({ message: 'Request not found' });
  if (reqRecord.status !== 'PENDING') return res.status(400).json({ message: 'Request already handled' });

  const token = randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  reqRecord.status = 'APPROVED';
  reqRecord.handledBy = req.user?.id || 'system';
  reqRecord.handledAt = new Date().toISOString();
  reqRecord.token = token;
  reqRecord.tokenExpiresAt = expires;

  // add notification for user (if email present)
  notifications.push({ id: `n_${Date.now() + 1}`, userId: reqRecord.userId, title: 'Password reset approved', body: 'Your password reset was approved. Use the provided link or temporary password to sign in.', createdAt: new Date().toISOString(), read: false });

  // For development, return the token so it can be used in tests; in production, email it instead
  return res.json({ message: 'Approved', request: reqRecord, token: token });
});

app.post('/api/password-reset-requests/:id/reject', authenticate, authorize(['Admin']), (req, res) => {
  const id = req.params.id;
  const { notes } = req.body || {};
  const reqRecord = passwordResetRequests.find((r) => r.id === id);
  if (!reqRecord) return res.status(404).json({ message: 'Request not found' });
  if (reqRecord.status !== 'PENDING') return res.status(400).json({ message: 'Request already handled' });

  reqRecord.status = 'REJECTED';
  reqRecord.handledBy = req.user?.id || 'system';
  reqRecord.handledAt = new Date().toISOString();
  reqRecord.notes = String(notes || '').trim();

  notifications.push({ id: `n_${Date.now() + 2}`, userId: reqRecord.userId, title: 'Password reset rejected', body: `Your password reset request was rejected${reqRecord.notes ? `: ${reqRecord.notes}` : ''}`, createdAt: new Date().toISOString(), read: false });

  return res.json({ message: 'Rejected', request: reqRecord });
});

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  console.error('Unhandled request error:', error);
  const status = error?.message === 'CORS origin not allowed' ? 403 : 500;
  const message = status === 403
    ? 'Origin is not allowed'
    : IS_PRODUCTION
      ? 'Internal server error'
      : error?.message || 'Internal server error';

  return res.status(status).json({ message });
});

const listenOnPort = (port) => new Promise((resolve, reject) => {
  const server = app.listen(port, () => resolve(server));
  server.on('error', reject);
});

const startServer = async () => {
  await initializeDatabase();
  await hydrateStateFromDatabase();
  validateRuntimeConfig();
  await initMailTransporter();
  let port = Number(process.env.PORT || 4000);
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await listenOnPort(port);
      console.log(`MRS backend running on http://localhost:${port}`);
      console.log(`Database driver: ${getDatabaseDriver()}`);
      console.log(`Mail transport: ${mailTransporterMode === 'console' ? 'console' : mailTransporterName}`);
      if (!process.env.JWT_SECRET && !IS_PRODUCTION) {
        console.log('JWT_SECRET is not set. A temporary runtime secret was generated for this session.');
      }
      if (!IS_PRODUCTION) {
        const enabledAdminLogins = buildBootstrapAdminConfigs()
          .map((config) => `${config.employeeCode} (${config.email})`)
          .join(', ');
        console.log(`Bootstrap admin logins enabled for ${enabledAdminLogins}`);
      }
      if (port !== Number(process.env.PORT || 4000)) {
        console.log(`Port 4000 was in use, so the server started on fallback port ${port}.`);
      }
      return;
    } catch (error) {
      if (error && error.code === 'EADDRINUSE') {
        console.warn(`Port ${port} is already in use, trying port ${port + 1}...`);
        port += 1;
        continue;
      }
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  console.error(`Unable to start MRS backend after ${maxAttempts} attempts.`);
  process.exit(1);
};

startServer();
