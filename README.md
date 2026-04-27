# ランダム指名

授業中にランダムで学生を指名するWebアプリ。教職員のみがADアカウントでログインして使用できます。

## 動作環境

- Node.js v24+
- PostgreSQL 16（`students` データベース）
- Active Directory（LDAP認証）

## セットアップ

```bash
npm install
cp .env.example .env
# .env を編集して各種設定を入力
npm start
```

アクセス URL: `http://<サーバーIP>/name-roulette/`

## 環境変数（.env）

| 変数名 | 説明 | デフォルト |
|---|---|---|
| `PORT` | サーバーポート | `3001` |
| `DB_HOST` | PostgreSQL ホスト | `172.16.10.11` |
| `DB_PORT` | PostgreSQL ポート | `5432` |
| `DB_NAME` | データベース名 | `students` |
| `DB_USER` | DBユーザー | `name_roulette_ro` |
| `DB_PASSWORD` | DBパスワード | — |
| `AD_LDAP_URL` | LDAPサーバーURL | `ldap://172.16.0.1` |
| `AD_DOMAIN` | ADドメイン | `yse.ac.jp` |
| `AD_BASE_DN` | LDAP ベースDN | `DC=yse,DC=ac,DC=jp` |
| `AD_REQUIRED_GROUP` | ログイン許可グループ | `教職員` |
| `SESSION_SECRET` | セッション署名キー（必須）| — |

## 認証

Active Directory の `教職員` グループに所属するアカウントのみログイン可能。

**フロー:**
1. ページを開くとセッション確認 → 未ログインならログイン画面を表示
2. ユーザー名＋パスワードを入力 → `username@yse.ac.jp` の UPN でLDAPバインド
3. バインド成功後に `memberOf` を確認し `教職員` グループへの所属を検証
4. 認証OKでセッション発行（有効期間: 8時間）
5. セッションが切れると自動的にログイン画面へ戻る

## APIエンドポイント

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| `GET` | `/name-roulette/auth/status` | 不要 | セッション確認 |
| `POST` | `/name-roulette/auth/login` | 不要 | ログイン（body: `{username, password}`） |
| `POST` | `/name-roulette/auth/logout` | 不要 | ログアウト |
| `GET` | `/name-roulette/api/class-groups` | 必須 | クラスグループ一覧 |
| `GET` | `/name-roulette/api/students` | 必須 | 学生一覧（`?class_group=` でフィルタ） |

## プロセス管理

```bash
# PM2 で起動
npx pm2 start ecosystem.config.js

# 再起動
npx pm2 restart name-roulette
```
