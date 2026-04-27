// ランダム指名ツール - Express サーバー
'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// ベースパス
const BASE_PATH = '/name-roulette';

// helmet: ContentSecurityPolicy は inline script があるため無効化
app.use(helmet({
  contentSecurityPolicy: false,
}));

// JSON パース
app.use(express.json());

// PostgreSQL 接続プール
const pool = new Pool({
  host:     process.env.DB_HOST     || '172.16.10.11',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'students',
  user:     process.env.DB_USER     || 'name_roulette_ro',
  password: process.env.DB_PASSWORD || '',
});

// DB 接続確認
pool.connect((err, client, release) => {
  if (err) {
    console.error('PostgreSQL 接続エラー:', err.message);
  } else {
    console.log('PostgreSQL 接続成功');
    release();
  }
});

// 静的ファイル配信 ( /name-roulette → public/ )
app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// ========== API エンドポイント ==========

/**
 * GET /name-roulette/api/class-groups
 * class_group の一覧を取得
 */
app.get(`${BASE_PATH}/api/class-groups`, async (req, res) => {
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
 * 学生一覧を取得（class_group 指定時はフィルタリング）
 */
app.get(`${BASE_PATH}/api/students`, async (req, res) => {
  try {
    const { class_group } = req.query;

    let result;
    if (class_group) {
      // SQL インジェクション対策: プレースホルダー $1 を使用
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

// 404 ハンドラ
app.use((req, res) => {
  res.status(404).json({ error: 'エンドポイントが見つかりません' });
});

// エラーハンドラ
app.use((err, req, res, _next) => {
  console.error('サーバーエラー:', err.message);
  res.status(500).json({ error: 'サーバー内部エラーが発生しました' });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`name-roulette サーバー起動: http://localhost:${PORT}${BASE_PATH}`);
});
