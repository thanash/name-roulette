// ランダム指名ツール - Express サーバー
'use strict';

require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const session = require('express-session');
const path    = require('path');
const { Pool } = require('pg');
const { Client: LdapClient } = require('ldapts');

const app       = express();
const PORT      = process.env.PORT      || 3001;
const BASE_PATH = '/name-roulette';

const AD_LDAP_URL       = process.env.AD_LDAP_URL       || 'ldap://172.16.0.1';
const AD_DOMAIN         = process.env.AD_DOMAIN         || 'yse.ac.jp';
const AD_BASE_DN        = process.env.AD_BASE_DN        || 'DC=yse,DC=ac,DC=jp';
const AD_REQUIRED_GROUP = process.env.AD_REQUIRED_GROUP || '教職員';

// ========== ミドルウェア ==========

// helmet: ContentSecurityPolicy は inline script があるため無効化
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json());

app.use(session({
  secret:            process.env.SESSION_SECRET || 'changeme',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000, // 8時間
  },
}));

// ========== PostgreSQL ==========

const pool = new Pool({
  host:     process.env.DB_HOST     || '172.16.10.11',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'students',
  user:     process.env.DB_USER     || 'name_roulette_ro',
  password: process.env.DB_PASSWORD || '',
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('PostgreSQL 接続エラー:', err.message);
  } else {
    console.log('PostgreSQL 接続成功');
    release();
  }
});

// ========== LDAP 認証 ==========

/**
 * ユーザー名・パスワードで AD に対して認証し、教職員グループ所属を確認する。
 * @param {string} username - ドメインなしのユーザー名
 * @param {string} password
 * @returns {Promise<{displayName: string}>}
 * @throws ログイン失敗時にエラーをスロー
 */
async function authenticateAD(username, password) {
  // ユーザー名に使用できない文字を拒否（LDAPインジェクション対策）
  if (!/^[\w\-.]+$/.test(username)) {
    throw new Error('無効なユーザー名です');
  }

  const client = new LdapClient({
    url:            AD_LDAP_URL,
    connectTimeout: 5000,
    tlsOptions:     { rejectUnauthorized: false },
  });

  try {
    // UPN 形式 (username@yse.ac.jp) でバインド → パスワード検証
    await client.bind(`${username}@${AD_DOMAIN}`, password);

    // ユーザーオブジェクトを検索して memberOf・表示名を取得
    const { searchEntries } = await client.search(AD_BASE_DN, {
      scope:      'sub',
      filter:     `(sAMAccountName=${username})`,
      attributes: ['memberOf', 'displayName', 'cn'],
    });

    if (searchEntries.length === 0) {
      throw new Error('ユーザーが見つかりません');
    }

    const user = searchEntries[0];

    // memberOf の各 DN から CN 部分を取り出して教職員グループを確認
    const memberOf = Array.isArray(user.memberOf)
      ? user.memberOf
      : (user.memberOf ? [user.memberOf] : []);

    const isInRequiredGroup = memberOf.some(dn => {
      const match = dn.match(/^CN=([^,]+)/i);
      return match && match[1] === AD_REQUIRED_GROUP;
    });

    if (!isInRequiredGroup) {
      throw new Error('教職員グループに所属していません');
    }

    const displayName = user.displayName || user.cn || username;
    return { displayName: String(displayName) };

  } finally {
    await client.unbind();
  }
}

// ========== 認証ミドルウェア ==========

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.status(401).json({ error: '認証が必要です' });
}

// ========== 認証 API ==========

/**
 * POST /name-roulette/auth/login
 * body: { username, password }
 */
app.post(`${BASE_PATH}/auth/login`, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
  }

  try {
    const { displayName } = await authenticateAD(username, password);

    req.session.regenerate(err => {
      if (err) {
        console.error('セッション再生成エラー:', err);
        return res.status(500).json({ error: 'サーバーエラーが発生しました' });
      }
      req.session.user = { username, displayName };
      res.json({ ok: true, displayName });
    });

  } catch (err) {
    console.warn(`ログイン失敗 [${username}]:`, err.message);
    // 詳細なエラー理由はクライアントに返さない
    res.status(401).json({ error: 'ユーザー名またはパスワードが正しくないか、教職員アカウントではありません' });
  }
});

/**
 * POST /name-roulette/auth/logout
 */
app.post(`${BASE_PATH}/auth/logout`, (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('セッション破棄エラー:', err);
    }
    res.json({ ok: true });
  });
});

/**
 * GET /name-roulette/auth/status
 * ログイン状態の確認
 */
app.get(`${BASE_PATH}/auth/status`, (req, res) => {
  if (req.session && req.session.user) {
    res.json({ loggedIn: true, displayName: req.session.user.displayName });
  } else {
    res.json({ loggedIn: false });
  }
});

// ========== 静的ファイル配信 ==========

app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// ========== API エンドポイント（認証必須）==========

/**
 * GET /name-roulette/api/class-groups
 */
app.get(`${BASE_PATH}/api/class-groups`, requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT class_group FROM students WHERE class_group IS NOT NULL ORDER BY class_group'
    );
    res.json(result.rows.map(row => row.class_group));
  } catch (err) {
    console.error('class-groups 取得エラー:', err.message);
    res.status(500).json({ error: 'クラスグループの取得に失敗しました' });
  }
});

/**
 * GET /name-roulette/api/students?class_group=xxx
 */
app.get(`${BASE_PATH}/api/students`, requireAuth, async (req, res) => {
  try {
    const { class_group } = req.query;

    let result;
    if (class_group) {
      result = await pool.query(
        'SELECT id, student_number, name, kana, class_group FROM students WHERE class_group = $1 ORDER BY student_number',
        [class_group]
      );
    } else {
      result = await pool.query(
        'SELECT id, student_number, name, kana, class_group FROM students ORDER BY student_number'
      );
    }

    res.json(result.rows);
  } catch (err) {
    console.error('students 取得エラー:', err.message);
    res.status(500).json({ error: '学生データの取得に失敗しました' });
  }
});

// ========== エラーハンドラ ==========

app.use((req, res) => {
  res.status(404).json({ error: 'エンドポイントが見つかりません' });
});

app.use((err, req, res, _next) => {
  console.error('サーバーエラー:', err.message);
  res.status(500).json({ error: 'サーバー内部エラーが発生しました' });
});

// ========== サーバー起動 ==========

app.listen(PORT, () => {
  console.log(`name-roulette サーバー起動: http://localhost:${PORT}${BASE_PATH}`);
});
