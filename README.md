# 学涯拼图 · 培养方案与选课提醒（学生端）

面向信息管理与信息系统专业本科生的学业导航系统。学生导入教务系统导出的成绩后，系统自动完成
「课程 → 培养方案条目」匹配，输出学分完成度、模块完成度、本学期选课建议与毕业风险提示。

**技术栈**：纯 HTML / CSS / JavaScript 前端 + Node.js 后端 + MySQL 8 数据库（无前端框架、无后端框架）

## 功能特性

- **多专业培养方案**：内置工程管理、土地资源管理、行政管理、信息管理与信息系统 4 份 2023 版培养方案，学生登录后按名册专业自动加载对应方案；
- **成绩单解析导入**：支持教务系统导出的 PDF 课表/成绩单与 Excel 花名册，自动提取课程、学分与修读状态；
- **课程自动匹配**：课程名归一化函数（兼容全半角、括号变体）精确匹配培养方案；匹配不上的课程按「课程类别」兜底建档，保证学分核算不漏课；
- **无绩点隐私模式**：开启后导入的成绩不记分数、不计绩点，后台同样不可见，保护同学隐私；
- **行级数据权限**：登录令牌 HMAC 签名，每个请求在事务内把用户写入 MySQL 会话变量，存储过程经 `fn_current_uid()` 做行级归属校验，学生只能读写本人数据；
- **管理员后台**：名册批量导入（按学号 upsert）、账号角色管理（提升/降级管理员，含「最后一个管理员」保护）；
- **一键部署**：`deploy.sh` 在 Ubuntu 服务器上自动完成 MySQL 安装、建库、systemd 服务注册，可选绑定域名并自动配置 HTTPS。

## 一、环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| MySQL | 8.0.19 及以上 | 需支持 CHECK 约束、窗口函数 |
| Node.js | 18 及以上 | 后端运行时，仅依赖 `mysql2` 一个驱动包 |
| 浏览器 | Chrome / Edge | 前端无需构建，直接由后端托管 |

## 二、快速开始

1. 确认本机 MySQL 服务已启动（默认 `127.0.0.1:3306`，账号 `root`）。
2. 双击 **`init-db.bat`**：自动安装后端依赖，并执行 `server/sql/score_db_mysql.sql`
   完成建库、建表、视图、触发器、函数、存储过程与初始数据导入。
3. 双击 **`start.bat`**：启动服务并自动打开浏览器，访问 <http://127.0.0.1:8787/>。
4. 登录页选择「注册 / 验证码登录」，本机版验证码直接显示在页面上并自动填入
   （不接短信与邮件），填入学号与姓名即可完成注册。
5. 关闭窗口即停止服务；数据库为独立 MySQL 服务，不受影响。

> 数据库连接参数在 `start.bat` 与 `init-db.bat` 顶部的 `MYSQL_HOST / MYSQL_PORT /
> MYSQL_USER / MYSQL_PASSWORD` 中修改，服务端口为 `PORT`（默认 8787）。

## 三、目录结构

```
score-system-local/
├─ init-db.bat            初始化数据库（执行建库脚本）
├─ start.bat              启动服务
├─ web/                   前端
│  ├─ index.html
│  └─ assets/
│     ├─ app.js           业务逻辑：培养方案对照、学分核算、图表、导入导出
│     ├─ app.css          样式（含手绘风格 SVG 装饰）
│     ├─ cloud-client.js  数据客户端：封装数据库读写与登录接口
│     ├─ plan-2023.json   2023 版本科培养方案（只读，前端内置）
│     ├─ plan-tree.html   培养方案树状解读（独立页面）
│     └─ vendor/          SheetJS（浏览器端 .xlsx 读写）
└─ server/                后端（Node.js，零框架）
   ├─ index.js            HTTP 服务：数据表接口 / 业务过程接口 / 登录鉴权
   ├─ db.js               连接池与事务（每个请求注入 @app_uid 会话变量）
   ├─ auth.js             账号、登录态（scrypt 加盐 + HMAC token）、验证码
   ├─ bootstrap.js        初始化数据库：按 DELIMITER 切分并执行建库脚本
   ├─ package.json        依赖清单（mysql2）
   └─ sql/
      └─ score_db_mysql.sql   完整建库脚本（可直接在 Navicat 中运行）
```

## 四、数据库设计

`score_db` 共 9 张基本表、3 个视图、2 个触发器、3 个函数、9 个存储过程。

| 表 | 说明 |
|---|---|
| `plan_categories` | 培养方案类目（自关联树：模块 → 子类目） |
| `plan_courses` | 培养方案课程（含「任选」占位课，`is_generic=1`） |
| `students` | 学生名册（学号、姓名、班级、专业、入学年份） |
| `courses` | 课程库（课程号、课程名、学分、学时、课程性质） |
| `course_arrangements` | 开课安排（课程 × 班级 × 学期） |
| `scores` | 成绩（平时/期末/总评/绩点/绩点开关/状态） |
| `user_profiles` | 账号档案（owner_id、角色、绑定学号、演示模式） |
| `users` | 登录账号（邮箱/手机、口令散列） |
| `operation_logs` | 操作日志 |

- **视图**：`v_score_detail`（成绩明细四表联结）、`v_student_credit`（学生学分汇总）、
  `v_course_arrange_detail`（开课明细）。
- **触发器**：成绩与档案的 `updated_at` 自动维护。
- **函数**：`fn_current_uid()`（读取会话变量 `@app_uid`）、`fn_score_to_gp()`（成绩换算绩点）、
  `fn_norm_name()`（课程名归一化，兼容全半角与括号变体）。
- **存储过程**：`sp_register_identity`、`sp_ensure_course`、`sp_import_student_courses`、
  `sp_save_student_score`、`sp_update_student_score`、`sp_delete_student_score`、
  `sp_batch_update_score_gp`、`sp_batch_delete_scores`、`sp_gc_orphan_placeholders`。

建库脚本可在 Navicat 中直接运行，也可用命令行：

```bash
mysql -u root -p --default-character-set=utf8mb4 < server/sql/score_db_mysql.sql
```

## 五、后端接口

| 接口 | 说明 |
|---|---|
| `POST /api/auth/send-otp` `verify-otp` `login` `logout` `session` | 登录注册与会话 |
| `POST /api/db/:table/:op` | 表读写：`select / insert / upsert / update / delete`，带列白名单与角色校验 |
| `POST /api/rpc/:fn` | 业务过程：注册身份、导入选课、增改删成绩、批量改绩点开关、批量删除 |

- 登录态使用 HMAC 签名的 token（有效期 7 天），由前端保存在 `localStorage`；
- 每个请求在独立事务中执行，事务开始时把当前用户写入会话变量 `@app_uid`，
  存储过程通过 `fn_current_uid()` 读取，实现行级归属校验；
- 学生只能读写本人档案与本人成绩，管理类表只读。

## 六、常见问题

- **启动报「ER_ACCESS_DENIED_ERROR」**：检查 `start.bat` 中的 `MYSQL_USER / MYSQL_PASSWORD`。
- **端口被占**：修改 `start.bat` 中的 `PORT`。
- **重置数据**：重新运行 `init-db.bat`（脚本会重建 `score_db`，原有数据将被清空）。
- **局域网访问**：把 `server/index.js` 中的监听地址由 `127.0.0.1` 改为 `0.0.0.0`，
  并在系统防火墙放行端口。
