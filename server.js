// ランダム指名ツール - Express サーバー
'use strict';

require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const session = require('express-session');
const path    = require('path');
const { Pool } = require('pg');
const { spawn, execFile } = require('child_process');

const app       = express();
const PORT      = process.env.PORT      || 3001;
const BASE_PATH = '/name-roulette';

const AD_REALM          = process.env.AD_REALM          || 'YSE.AC.JP';
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

// ========== Kerberos 認証 ==========

/**
 * kinit でパスワード検証 → getent でグループ確認。
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{displayName: string}>}
 */
function authenticateAD(username, password) {
  // シェルインジェクション対策: 英数字・ハイフン・アンダースコア・ドットのみ許可
  if (!/^[\w\-.]+$/.test(username)) {
    return Promise.reject(new Error('無効なユーザー名です'));
  }

  return new Promise((resolve, reject) => {
    // 一時的な Kerberos 認証情報キャッシュ（並列リクエストが干渉しないよう個別ファイル）
    const ccache = `/tmp/krb5cc_nr_${process.pid}_${Date.now()}`;
    const env    = { ...process.env, KRB5CCNAME: `FILE:${ccache}` };

    const kinit = spawn('/usr/bin/kinit', [`${username}@${AD_REALM}`], { env });

    let stderr = '';
    kinit.stderr.on('data', d => { stderr += d.toString(); });

    // kinit はパスワードプロンプトを stderr に出し、stdin から読む
    kinit.stdin.write(password + '\n');
    kinit.stdin.end();

    kinit.on('close', code => {
      // 認証情報キャッシュを即時削除
      require('fs').unlink(ccache, () => {});

      if (code !== 0) {
        return reject(new Error(`kinit 失敗 (code=${code})`));
      }

      // SSSD 経由でグループ所属を確認
      execFile('id', ['-Gn', username], (err, stdout) => {
        if (err) return reject(new Error('グループ確認失敗'));

        const groups = stdout.trim().split(/\s+/);
        if (!groups.includes(AD_REQUIRED_GROUP)) {
          return reject(new Error('教職員グループに所属していません'));
        }

        resolve({ displayName: username });
      });
    });

    kinit.on('error', err => {
      require('fs').unlink(ccache, () => {});
      reject(err);
    });
  });
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
