import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDatabaseDriver, initializeDatabase, loadCollection, saveCollection } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const loadLocalEnv = () => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const envLines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
};

loadLocalEnv();

const app = express();
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const PORT = process.env.PORT || 4000;
const GENERATED_JWT_SECRET = `mrn_dev_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? '' : GENERATED_JWT_SECRET);
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'somaskandhanmj@gmail.com').trim().toLowerCase();
const ADMIN_EMPLOYEE_CODE = String(process.env.ADMIN_EMPLOYEE_CODE || 'ADM001').trim().toUpperCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? '' : 'Kandhan28@@');
const ADMIN_ID = `u_${ADMIN_EMAIL}`;
const DEFAULT_DEV_PASSWORDS = {
  admin: 'Kandhan28@@',
  requester: 'Requester123',
  issuer: 'Issuer123',
};
const PASSWORD_HASH_PREFIX = 'scrypt';
const MAIL_FROM = process.env.MAIL_FROM || 'MRN System <no-reply@example.com>';
const DEFAULT_PRODUCTION_FRONTEND_URL = 'https://tase-mrn-frontend.vercel.app';
const DEFAULT_PRODUCTION_BACKEND_URL = 'https://tase-mrn-backend.onrender.com';
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
let mailTransporter = null;
let mailTransporterName = 'console';
let mailTransporterMode = 'console';

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

const enableLocalStreamMailTransport = (reason) => {
  if (reason) {
    console.log(reason);
  }

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
  const mailEncryption = String(process.env.MAIL_ENCRYPTION || '').trim().toLowerCase();
  const mailSecure = process.env.MAIL_SECURE === 'true' || mailEncryption === 'ssl' || mailPort === 465;
  const mailRequireTLS = mailEncryption === 'tls';

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
      console.log(`SMTP mail transport configured via ${mailHost}`);
    } catch (error) {
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
      mailTransporterName = 'Ethereal';
      mailTransporterMode = 'ethereal';
      console.log('Using Ethereal test email service for development. Email preview URLs will be logged.');
      return;
    } catch (error) {
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
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

app.get('/', (req, res) => {
  res.send('MRN backend is running');
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', environment: NODE_ENV });
});

app.get('/readyz', (req, res) => {
  res.json({
    status: 'ready',
    environment: NODE_ENV,
    mailTransport: mailTransporterName,
    database: getDatabaseDriver(),
  });
});

const seededNotifications = [];

const seededUsers = [
  {
    id: ADMIN_ID,
    name: 'System Administrator',
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: 'Admin',
    department: 'Engineering',
    employeeCode: ADMIN_EMPLOYEE_CODE,
    companyRole: 'Admin',
    status: 'Active',
    avatar: 'SA',
    lastActive: new Date().toISOString(),
  },
  {
    id: 'u_req_ahmed',
    name: 'Ahmed Hassan',
    email: 'ahmed.hassan@example.com',
    password: DEFAULT_DEV_PASSWORDS.requester,
    role: 'Requester',
    department: 'Engineering',
    employeeCode: 'REQ101',
    companyRole: 'Engineer',
    status: 'Active',
    avatar: 'AH',
    lastActive: new Date().toISOString(),
  },
  {
    id: 'u_req_fatima',
    name: 'Fatima Hassan',
    email: 'fatima.hassan@example.com',
    password: DEFAULT_DEV_PASSWORDS.requester,
    role: 'Requester',
    department: 'Operations',
    employeeCode: 'REQ102',
    companyRole: 'Operations Coordinator',
    status: 'Active',
    avatar: 'FH',
    lastActive: new Date().toISOString(),
  },
  {
    id: 'u_issuer_omar',
    name: 'Omar Wael',
    email: 'omar.wael@example.com',
    password: DEFAULT_DEV_PASSWORDS.issuer,
    role: 'Issuer',
    department: 'Warehouse',
    employeeCode: 'ISS201',
    companyRole: 'Store Issuer',
    status: 'Active',
    avatar: 'OW',
    lastActive: new Date().toISOString(),
  },
];

const seededMrns = [
  {
    id: 'MRN-1001',
    date: '2026-04-10',
    requester: 'Ahmed Hassan',
    department: 'Engineering',
    status: 'Submitted',
    slaStatus: 'on-time',
    slaHoursLeft: 72,
    priority: 'High',
    materials: [
      {
        id: 'm-1',
        materialCode: 'ABC-001',
        description: '12V Pump Assembly',
        spec: 'Standard duty',
        uom: 'PCS',
        requestedQty: 4,
        issuedQty: 0,
        returnedQty: 0,
        status: 'Pending',
      },
      {
        id: 'm-2',
        materialCode: 'BFG-013',
        description: 'Coupling Gasket',
        spec: 'NBR, 50mm',
        uom: 'PCS',
        requestedQty: 10,
        issuedQty: 0,
        returnedQty: 0,
        status: 'Pending',
      },
    ],
    comments: [
      {
        id: 'c-1001',
        author: 'Ahmed Hassan',
        role: 'Requester',
        message: 'Please prioritize this for the new site installation.',
        timestamp: '2026-04-10T08:30:00Z',
        avatar: 'AH',
      },
    ],
    timeline: [
      {
        id: 't-1001',
        label: 'Request created',
        status: 'completed',
        timestamp: '2026-04-10T08:30:00Z',
        actor: 'Ahmed Hassan',
        note: 'Initial MRN submitted',
      },
      {
        id: 't-1002',
        label: 'Pending approval',
        status: 'active',
      },
    ],
  },
  {
    id: 'MRN-1002',
    date: '2026-04-12',
    requester: 'Fatima Hassan',
    department: 'Operations',
    status: 'Approved',
    slaStatus: 'near-breach',
    slaHoursLeft: 18,
    priority: 'Medium',
    materials: [
      {
        id: 'm-3',
        materialCode: 'CDE-210',
        description: 'Hydraulic Hose',
        spec: '3/8" x 1m',
        uom: 'PCS',
        requestedQty: 6,
        issuedQty: 0,
        returnedQty: 0,
        status: 'Pending',
      },
    ],
    comments: [
      {
        id: 'c-1002',
        author: 'Sara Ali',
        role: 'L1 Approver',
        message: 'Approved for immediate issue.',
        timestamp: '2026-04-12T11:20:00Z',
        avatar: 'SA',
      },
    ],
    timeline: [
      {
        id: 't-1003',
        label: 'Request created',
        status: 'completed',
        timestamp: '2026-04-12T10:45:00Z',
        actor: 'Fatima Hassan',
      },
      {
        id: 't-1004',
        label: 'Approved',
        status: 'completed',
        timestamp: '2026-04-12T11:20:00Z',
        actor: 'Sara Ali',
      },
      {
        id: 't-1005',
        label: 'Ready for issue',
        status: 'active',
      },
    ],
  },
  {
    id: 'MRN-1003',
    date: '2026-04-08',
    requester: 'Ali Mohammed',
    department: 'Projects',
    status: 'Partially Returned',
    slaStatus: 'on-time',
    slaHoursLeft: 0,
    priority: 'Low',
    grnNumber: 'GRN-2408',
    materials: [
      {
        id: 'm-4',
        materialCode: 'XYZ-900',
        description: 'Cable Tray 2m',
        spec: 'Galvanized steel',
        uom: 'PCS',
        requestedQty: 12,
        issuedQty: 12,
        returnedQty: 4,
        status: 'Partially Returned',
      },
    ],
    comments: [
      {
        id: 'c-1003',
        author: 'Omar Wael',
        role: 'Issuer',
        message: 'Issued to maintenance team.',
        timestamp: '2026-04-08T14:55:00Z',
        avatar: 'OW',
      },
      {
        id: 'c-1004',
        author: 'Omar Wael',
        role: 'Issuer',
        message: 'Returned 4 PCS from site stock reconciliation.',
        timestamp: '2026-04-09T09:15:00Z',
        avatar: 'OW',
      },
    ],
    timeline: [
      {
        id: 't-1006',
        label: 'Approved',
        status: 'completed',
        timestamp: '2026-04-08T12:10:00Z',
        actor: 'Mohammed Rashid',
      },
      {
        id: 't-1007',
        label: 'Issued',
        status: 'completed',
        timestamp: '2026-04-08T14:55:00Z',
        actor: 'Omar Wael',
      },
      {
        id: 't-1008',
        label: 'Return recorded',
        status: 'completed',
        timestamp: '2026-04-09T09:15:00Z',
        actor: 'Omar Wael',
        note: '4 PCS returned from issued stock.',
      },
    ],
  },
];

let notifications = structuredClone(seededNotifications);
let users = structuredClone(seededUsers);
let mrns = structuredClone(seededMrns);

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
  companyRole: user.companyRole,
  status: user.status,
  avatar: user.avatar,
  lastActive: user.lastActive,
});

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
    ? `<img src="cid:${EMAIL_LOGO_CID}" alt="TASE Digital logo" width="56" height="56" style="display: block; width: 56px; height: 56px; border-radius: 16px; background-color: rgba(255, 255, 255, 0.14); padding: 6px;" />`
    : `<div style="width: 56px; height: 56px; border-radius: 16px; background-color: rgba(255, 255, 255, 0.14); color: #ffffff; font-size: 20px; font-weight: 700; line-height: 56px; text-align: center;">TD</div>`;

const buildEmailShell = ({
  preheader,
  title,
  intro,
  bodyHtml,
  buttonLabel = 'Access your app',
  buttonUrl = FRONTEND_URL,
  footerTitle = 'TASE Digital MRN',
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
      <body style="margin: 0; padding: 0; background-color: #eef4ff; font-family: Arial, sans-serif; color: #0f172a;">
        <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${safePreheader}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #eef4ff; padding: 24px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 640px;">
                <tr>
                  <td style="padding-bottom: 16px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius: 24px; overflow: hidden; background: linear-gradient(135deg, #0f172a 0%, #1d4ed8 100%);">
                      <tr>
                        <td style="padding: 28px 32px;">
                          <table role="presentation" cellpadding="0" cellspacing="0">
                            <tr>
                              <td style="vertical-align: middle;">
                                ${brandMarkHtml}
                              </td>
                              <td style="padding-left: 16px; vertical-align: middle;">
                                <p style="margin: 0; font-size: 12px; line-height: 18px; letter-spacing: 0.24em; text-transform: uppercase; color: rgba(255, 255, 255, 0.72);">TASE Digital</p>
                                <h1 style="margin: 6px 0 0; font-size: 28px; line-height: 34px; color: #ffffff;">${safeTitle}</h1>
                              </td>
                            </tr>
                          </table>
                          <p style="margin: 20px 0 0; font-size: 15px; line-height: 24px; color: rgba(255, 255, 255, 0.88);">${safeIntro}</p>
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
                        <td align="center" bgcolor="#1d4ed8" style="border-radius: 999px;">
                          <a href="${safeButtonUrl}" style="display: inline-block; padding: 14px 26px; font-size: 15px; font-weight: 700; color: #ffffff; text-decoration: none;">${safeButtonLabel}</a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 0 0 8px; font-size: 13px; line-height: 21px; color: #475569;">If the button does not open, copy this link into your browser:</p>
                    <p style="margin: 0; font-size: 13px; line-height: 22px; word-break: break-all;">
                      <a href="${safeButtonUrl}" style="color: #1d4ed8; text-decoration: none;">${safeButtonUrl}</a>
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

const getAdminUser = () => users.find((user) => user.id === ADMIN_ID);

const getRequesterUser = (mrn) =>
  users.find((user) => user.role === 'Requester' && user.name === mrn.requester);

const sanitizeQty = (value) => {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 0) return 0;
  return qty;
};

const getRequestedQty = (item) => sanitizeQty(item.requestedQty ?? item.qty);
const getIssuedQty = (item) => sanitizeQty(item.issuedQty);
const getReturnedQty = (item) => sanitizeQty(item.returnedQty);

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
    return mrn.status;
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
  Approved: ['issue', 'not_available'],
  'Partially Issued': ['issue', 'return'],
  Rejected: [],
  Issued: ['return'],
  'Partially Returned': ['return'],
  Returned: [],
  'Not Available': [],
};

const saveUsers = () => saveCollection('users', users);
const saveMrns = () => saveCollection('mrns', mrns);
const saveNotifications = () => saveCollection('notifications', notifications);

const ensurePrimaryAdmin = () => {
  if (users.some((user) => user.id === ADMIN_ID)) {
    return;
  }

  users.unshift(structuredClone(seededUsers[0]));
};

const normalizeStoredUsers = (items) =>
  items.map((user) => {
    const normalizedPassword = isPasswordHash(user.password)
      ? user.password
      : hashPassword(user.password || DEFAULT_DEV_PASSWORDS.requester);

    return {
      ...user,
      email: String(user.email || '').trim().toLowerCase(),
      employeeCode: normalizeEmployeeCode(user.employeeCode),
      password: normalizedPassword,
      avatar: user.avatar || buildAvatar(user.name),
      lastActive: user.lastActive || new Date().toISOString(),
    };
  });

const normalizeMRNs = (items) =>
  items.map((mrn) => {
    const normalizedMaterials = Array.isArray(mrn.materials)
      ? mrn.materials.map(normalizeMaterial)
      : [];

    const normalizedMrn = {
      ...mrn,
      materials: normalizedMaterials,
    };

    return {
      ...normalizedMrn,
      status: deriveMRNStatus(normalizedMrn),
    };
  });

const hydrateStateFromDatabase = async () => {
  users = await loadCollection('users', seededUsers);
  mrns = await loadCollection('mrns', seededMrns);
  notifications = await loadCollection('notifications', seededNotifications);

  users = Array.isArray(users) ? normalizeStoredUsers(users) : normalizeStoredUsers(seededUsers);
  notifications = Array.isArray(notifications) ? notifications : structuredClone(seededNotifications);
  mrns = Array.isArray(mrns) ? normalizeMRNs(mrns) : normalizeMRNs(seededMrns);

  ensurePrimaryAdmin();
  await Promise.all([
    saveUsers(),
    saveMrns(),
    saveNotifications(),
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

  if (IS_PRODUCTION && CORS_ORIGINS.length === 0) {
    missing.push('CORS_ORIGINS');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  }
};

const sendMailMessage = async ({ to, subject, text, html, logLabel, attachments = [] }) => {
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

Welcome to TASE Digital MRN.

Your account has been created successfully. Use the credentials below to sign in:

Employee Code: ${user.employeeCode}
Temporary Password: ${tempPassword}

Registered Email: ${user.email}
Role: ${user.role}
Department: ${user.department}

Access your app: ${FRONTEND_URL}

Please sign in using your employee code and temporary password, then update your password after the first login.

Regards,
MRN System Admin`;

  const html = buildEmailShell({
    preheader: `Your TASE Digital MRN account is ready. Sign in with your employee code and temporary password.`,
    title: 'Your MRN account is ready',
    intro: 'A new TASE Digital workspace account has been created for you. Your access details are below.',
    buttonLabel: 'Access your app',
    buttonUrl: FRONTEND_URL,
    bodyHtml: `
      <p style="margin: 0 0 14px; font-size: 16px; line-height: 26px;">Hello <strong>${escapeHtml(user.name)}</strong>,</p>
      <p style="margin: 0 0 22px; font-size: 15px; line-height: 24px; color: #334155;">
        Your account has been activated successfully. Use the credentials below to sign in and start working in the MRN portal.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 22px; border: 1px solid #dbeafe; border-radius: 20px; background-color: #f8fbff;">
        <tr>
          <td style="padding: 22px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
              <tr>
                <td style="padding: 0 0 14px; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b;">Employee Code</td>
                <td style="padding: 0 0 14px; font-size: 15px; line-height: 20px; font-weight: 700; color: #0f172a;" align="right">${escapeHtml(user.employeeCode)}</td>
              </tr>
              <tr>
                <td style="padding: 14px 0; border-top: 1px solid #dbeafe; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b;">Temporary Password</td>
                <td style="padding: 14px 0; border-top: 1px solid #dbeafe; font-size: 15px; line-height: 20px; font-weight: 700; color: #0f172a;" align="right">${escapeHtml(tempPassword)}</td>
              </tr>
              <tr>
                <td style="padding: 14px 0; border-top: 1px solid #dbeafe; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b;">Email</td>
                <td style="padding: 14px 0; border-top: 1px solid #dbeafe; font-size: 15px; line-height: 20px; color: #0f172a;" align="right">${escapeHtml(user.email)}</td>
              </tr>
              <tr>
                <td style="padding: 14px 0 0; border-top: 1px solid #dbeafe; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b;">Role</td>
                <td style="padding: 14px 0 0; border-top: 1px solid #dbeafe; font-size: 15px; line-height: 20px; color: #0f172a;" align="right">${escapeHtml(user.role)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      <div style="margin: 0 0 22px; padding: 16px 18px; border-radius: 18px; background-color: #0f172a;">
        <p style="margin: 0; font-size: 13px; line-height: 22px; color: rgba(255, 255, 255, 0.82);">
          For security, please change your temporary password as soon as you complete your first login.
        </p>
      </div>
      <p style="margin: 0; font-size: 14px; line-height: 22px; color: #475569;">Regards,<br />MRN System Admin</p>
    `,
  });

  return sendMailMessage({
    to: user.email,
    subject: 'Welcome to TASE Digital MRN',
    text,
    html,
    logLabel: 'Welcome',
    attachments: getEmailLogoAttachments(),
  });
};

const sendRequesterContactEmail = async ({ requester, mrn, sender, message }) => {
  const text = `Hello ${requester.name},

The issuing team requested that you review MRN ${mrn.id}.

Message from ${sender.name}:
${message}

Current MRN status: ${mrn.status}
Department: ${mrn.department}
Access your app: ${FRONTEND_URL}

Regards,
MRN System`;

  const html = buildEmailShell({
    preheader: `${sender.name} asked you to review ${mrn.id}.`,
    title: `Action needed for ${mrn.id}`,
    intro: 'The issuing team needs your attention on an MRN request. Review the message below and continue in the app.',
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
      <p style="margin: 0; font-size: 14px; line-height: 22px; color: #475569;">Regards,<br />MRN System</p>
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
  const role = req.user.role;
  const name = req.user.name;

  if (role === 'Admin') {
    return res.json(mrns);
  }

  if (role === 'Requester') {
    return res.json(mrns.filter((mrn) => mrn.requester === name));
  }

  if (role === 'Issuer') {
    return res.json(
      mrns.filter((mrn) =>
        ['Approved', 'Partially Issued', 'Issued', 'Partially Returned', 'Returned', 'Not Available'].includes(mrn.status)
      )
    );
  }

  return res.json(mrns.filter((mrn) => mrn.status === 'Submitted' || mrn.status === 'Approved'));
});

app.get('/api/mrns/:id', authenticate, (req, res) => {
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRN not found' });
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

app.post('/api/mrns', authenticate, authorize(['Requester', 'Admin']), (req, res) => {
  const user = users.find((u) => u.id === req.user.id);
  const { priority, materials, purpose } = req.body;

  if (!materials || !Array.isArray(materials) || materials.length === 0) {
    return res.status(400).json({ message: 'Materials are required' });
  }

  const id = `MRN-${1000 + mrns.length + 1}`;
  const now = new Date().toISOString().slice(0, 10);
  const newMrn = {
    id,
    date: now,
    requester: user.name,
    department: user.department,
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
      status: 'Pending',
    })),
    comments: [
      {
        id: `c-${Date.now()}`,
        author: user.name,
        role: user.role,
        message: 'MRN created',
        timestamp: new Date().toISOString(),
        avatar: user.avatar,
      },
    ],
    timeline: [
      {
        id: `t-${Date.now()}`,
        label: 'MRN created',
        status: 'completed',
        timestamp: new Date().toISOString(),
        actor: user.name,
      },
      {
        id: `t-${Date.now() + 1}`,
        label: 'Pending approval',
        status: 'active',
      },
    ],
  };

  mrns.unshift(newMrn);
  saveMrns();
  return res.status(201).json(newMrn);
});

app.put('/api/mrns/:id/status', authenticate, (req, res) => {
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRN not found' });

  const { action, comment, grnNumber, materials } = req.body;
  const role = req.user.role;

  const transitionMap = {
    approve: ['L1 Approver', 'L2 Approver', 'Admin'],
    reject: ['L1 Approver', 'L2 Approver', 'Admin'],
    hold: ['L1 Approver', 'L2 Approver', 'Admin'],
    issue: ['Issuer', 'Admin'],
    return: ['Issuer', 'Admin'],
    not_available: ['Issuer', 'Admin'],
  };

  if (!action || !transitionMap[action]) {
    return res.status(400).json({ message: 'Invalid action' });
  }

  if (!transitionMap[action].includes(role)) {
    return res.status(403).json({ message: 'Action not allowed for your role' });
  }

  const allowedActions = transitionRules[mrn.status] || [];
  if (!allowedActions.includes(action)) {
    return res.status(409).json({ message: `Cannot ${action.replace('_', ' ')} when MRN is ${mrn.status}` });
  }
  if (action === 'issue' && !String(grnNumber || '').trim()) {
    return res.status(400).json({ message: 'GRN number is required before issuing materials' });
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
      materials.map((item) => [String(item.id), sanitizeQty(item.issuedQty)])
    );

    let hasIssuedQty = false;

    mrn.materials = mrn.materials.map((item) => {
      const requestedQty = getRequestedQty(item);
      const issuedQty = Math.min(materialUpdates.get(item.id) ?? getIssuedQty(item), requestedQty);
      const returnedQty = Math.min(getReturnedQty(item), issuedQty);
      const nextItem = normalizeMaterial({
        ...item,
        requestedQty,
        issuedQty,
        returnedQty,
      });

      if (issuedQty > 0) {
        hasIssuedQty = true;
      }

      return nextItem;
    });

    if (!hasIssuedQty) {
      return res.status(400).json({ message: 'At least one material must have an issued quantity greater than 0' });
    }

    mrn.grnNumber = String(grnNumber).trim();
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

    mrn.status = deriveMRNStatus(mrn);
    completeActiveTimelineSteps(mrn);
    mrn.timeline.push({
      id: `t-${Date.now()}`,
      label: 'Return recorded',
      status: 'completed',
      timestamp: now,
      actor,
      note: comment || 'Returned quantities were recorded against this MRN.',
    });
  } else {
    mrn.status = nextStatus;
    completeActiveTimelineSteps(mrn);

    if (action === 'not_available') {
      mrn.materials = mrn.materials.map((item) => ({
        ...normalizeMaterial({
          ...item,
          issuedQty: 0,
          returnedQty: 0,
          status: 'Not Available',
        }),
        status: 'Not Available',
      }));
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
      mrn.timeline.push({
        id: `t-${Date.now() + 1}`,
        label: 'Ready for issue',
        status: 'active',
      });
    }
  }

  mrn.comments.push({
    id: `c-${Date.now()}`,
    author: actor,
    role,
    message:
      action === 'issue' && mrn.grnNumber
        ? `${comment || `${role} executed ${action}`} (GRN: ${mrn.grnNumber})`
        : comment || `${role} executed ${action.replace('_', ' ')}`,
    timestamp: now,
    avatar: req.user.name ? buildAvatar(req.user.name) : '??',
  });

  saveMrns();
  return res.json(mrn);
});

app.post('/api/mrns/:id/contact-requester', authenticate, authorize(['Issuer', 'Admin']), async (req, res) => {
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRN not found' });

  const requester = getRequesterUser(mrn);
  if (!requester) {
    return res.status(404).json({ message: 'Requester account not found for this MRN' });
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
  return res.json({
    ...mrn,
    emailDelivery,
  });
});

app.post('/api/mrns/:id/comments', authenticate, (req, res) => {
  const mrn = mrns.find((item) => item.id === req.params.id);
  if (!mrn) return res.status(404).json({ message: 'MRN not found' });

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
  return res.status(201).json(mrn);
});

app.get('/api/users', authenticate, authorize(['Admin']), (req, res) => {
  return res.json(users.map(publicUser));
});

app.post('/api/users', authenticate, authorize(['Admin']), async (req, res) => {
  const { name, email, role, department, employeeCode, companyRole, status } = req.body;
  const normalizedEmail = String(email || '').toLowerCase().trim();
  const normalizedEmployeeCode = normalizeEmployeeCode(employeeCode);

  if (!name || !email || !role || !department || !employeeCode || !companyRole) {
    return res.status(400).json({ message: 'All user fields are required' });
  }

  const existingEmailUser = users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (existingEmailUser) {
    return res.status(409).json({ message: 'A user already exists with that email' });
  }
  if (String(role).trim() === 'Admin') {
    return res.status(409).json({ message: 'Only one admin account is allowed' });
  }
  if (findUserByEmployeeCode(normalizedEmployeeCode)) {
    return res.status(409).json({ message: 'A user already exists with that employee code' });
  }

  const tempPassword = `Temp@${Math.random().toString(36).slice(2, 10)}A1`;
  const id = `u_${normalizedEmployeeCode.toLowerCase()}`;
  const avatar = buildAvatar(name);
  const newUser = {
    id,
    name: String(name).trim(),
    email: normalizedEmail,
    password: hashPassword(tempPassword),
    role: String(role).trim(),
    department: String(department).trim(),
    employeeCode: normalizedEmployeeCode,
    companyRole: String(companyRole).trim(),
    status: status === 'Inactive' ? 'Inactive' : 'Active',
    avatar,
    lastActive: new Date().toISOString(),
  };

  users.push(newUser);
  saveUsers();

  try {
    await sendWelcomeEmail(newUser, tempPassword);
  } catch (error) {
    console.error('Failed to send onboarding email:', error);
  }

  return res.status(201).json(publicUser(newUser));
});

app.put('/api/users/:id', authenticate, authorize(['Admin']), (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const { name, role, department, status, employeeCode, companyRole } = req.body;
  const normalizedEmployeeCode = employeeCode ? normalizeEmployeeCode(employeeCode) : '';
  const isAdminAccount = user.id === ADMIN_ID;

  if (isAdminAccount && role && String(role).trim() !== 'Admin') {
    return res.status(400).json({ message: 'The primary admin role cannot be changed' });
  }
  if (isAdminAccount && status && String(status).trim() !== 'Active') {
    return res.status(400).json({ message: 'The primary admin account must remain active' });
  }
  if (!isAdminAccount && role && String(role).trim() === 'Admin') {
    return res.status(409).json({ message: 'Only one admin account is allowed' });
  }
  if (isAdminAccount && normalizedEmployeeCode && normalizedEmployeeCode !== ADMIN_EMPLOYEE_CODE) {
    return res.status(400).json({ message: 'The primary admin employee code cannot be changed' });
  }

  if (name) {
    user.name = String(name).trim();
    user.avatar = buildAvatar(user.name);
  }
  if (role) user.role = String(role).trim();
  if (department) user.department = String(department).trim();
  if (status) user.status = String(status).trim();
  if (normalizedEmployeeCode) {
    const existingEmployeeCodeUser = findUserByEmployeeCode(normalizedEmployeeCode);
    if (existingEmployeeCodeUser && existingEmployeeCodeUser.id !== user.id) {
      return res.status(409).json({ message: 'A user already exists with that employee code' });
    }
    user.employeeCode = normalizedEmployeeCode;
  }
  if (companyRole) user.companyRole = String(companyRole).trim();

  saveUsers();
  return res.json(publicUser(user));
});

app.delete('/api/users/:id', authenticate, authorize(['Admin']), (req, res) => {
  const userIndex = users.findIndex((u) => u.id === req.params.id);
  if (userIndex === -1) return res.status(404).json({ message: 'User not found' });

  if (users[userIndex].id === ADMIN_ID) {
    return res.status(400).json({ message: 'The primary admin account cannot be removed' });
  }

  if (users[userIndex].id === req.user.id) {
    return res.status(400).json({ message: 'You cannot remove your own account' });
  }

  const [removedUser] = users.splice(userIndex, 1);
  saveUsers();
  return res.json(publicUser(removedUser));
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
      console.log(`MRN backend running on http://localhost:${port}`);
      console.log(`Database driver: ${getDatabaseDriver()}`);
      console.log(`Mail transport: ${mailTransporter ? mailTransporterName : 'console'}`);
      if (!process.env.JWT_SECRET && !IS_PRODUCTION) {
        console.log('JWT_SECRET is not set. A temporary runtime secret was generated for this session.');
      }
      if (!IS_PRODUCTION) {
        console.log(`Primary admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD || DEFAULT_DEV_PASSWORDS.admin}`);
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

  console.error(`Unable to start MRN backend after ${maxAttempts} attempts.`);
  process.exit(1);
};

startServer();
