-- ============================================================
-- 学涯拼图  数据库结构与数据（MySQL 版）
-- 数据库：score_db      字符集：utf8mb4      存储引擎：InnoDB
-- 内容：9 张基本表 + 3 个视图 + 2 个触发器 + 3 个函数 + 10 个存储过程 + 初始化数据
-- 环境：MySQL 8.0.19 及以上
--
-- 执行方式：
--   ① Navicat for MySQL / Navicat Premium：新建查询 -> 粘贴本脚本 -> 运行
--   ② 命令行：mysql -u root -p --default-character-set=utf8mb4 < score_db_mysql.sql
--
-- 本脚本可重复执行：开头会先删掉旧的 score_db 再从头重建，
-- 因此即使上次执行中断留下残留表，再次执行也不会报「外键名重复」之类的错。
--
-- 关于 DELIMITER：存储过程 / 存储函数的内部含分号，必须用 DELIMITER 临时
-- 改变语句结束符，Navicat 与 mysql 命令行都认这个客户端指令。
-- ============================================================

DROP DATABASE IF EXISTS score_db;
CREATE DATABASE score_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE score_db;

-- ============================================================
-- 学涯拼图 · MySQL 表结构
-- 数据库：score_db      字符集：utf8mb4      存储引擎：InnoDB
-- 内容：9 张基本表 + 3 个视图 + 2 个触发器
-- 环境：MySQL 8.0.19 及以上（用到 CHECK 约束、行别名 ON DUPLICATE KEY）
-- ============================================================

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;
SET FOREIGN_KEY_CHECKS = 0;

DROP VIEW  IF EXISTS v_score_detail, v_student_credit, v_course_arrange_detail;
DROP TABLE IF EXISTS operation_logs, scores, course_arrangements, courses, students,
  user_profiles, users, plan_courses, plan_categories;

-- ------------------------------------------------------------
-- 1. 培养方案类目表（自关联树：模块 -> 子类目）
-- ------------------------------------------------------------
CREATE TABLE plan_categories (
  code             VARCHAR(20)  NOT NULL                COMMENT '类目代码',
  name             VARCHAR(100) NOT NULL                COMMENT '类目名称',
  parent_code      VARCHAR(20)           DEFAULT NULL   COMMENT '上级类目代码',
  required_credits DECIMAL(4,1)          DEFAULT NULL   COMMENT '要求学分',
  note             VARCHAR(255)          DEFAULT NULL   COMMENT '备注',
  sort             INT          NOT NULL DEFAULT 0      COMMENT '排序号',
  PRIMARY KEY (code),
  KEY idx_plan_cat_parent (parent_code),
  CONSTRAINT fk_plan_cat_parent FOREIGN KEY (parent_code) REFERENCES plan_categories (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='培养方案类目';

-- ------------------------------------------------------------
-- 2. 培养方案课程表
-- ------------------------------------------------------------
CREATE TABLE plan_courses (
  code          VARCHAR(20)  NOT NULL              COMMENT '课程代码',
  name          VARCHAR(100) NOT NULL              COMMENT '课程名称',
  credits       DECIMAL(3,1) NOT NULL              COMMENT '学分',
  sem_from      INT          NOT NULL              COMMENT '起始学期',
  sem_to        INT          NOT NULL              COMMENT '结束学期',
  category_code VARCHAR(20)  NOT NULL              COMMENT '所属类目代码',
  nature        VARCHAR(20)  NOT NULL DEFAULT '必修' COMMENT '课程性质',
  is_generic    TINYINT(1)   NOT NULL DEFAULT 0    COMMENT '是否通识/任选课（1 是 0 否）',
  note          VARCHAR(255)          DEFAULT NULL COMMENT '备注',
  PRIMARY KEY (code),
  KEY idx_plan_courses_cat (category_code),
  CONSTRAINT fk_plan_course_cat FOREIGN KEY (category_code) REFERENCES plan_categories (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='培养方案课程';

-- ------------------------------------------------------------
-- 3. 学生表（学号名册，注册与登录的校验依据）
-- ------------------------------------------------------------
CREATE TABLE students (
  student_id  VARCHAR(20)  NOT NULL               COMMENT '学号',
  name        VARCHAR(50)  NOT NULL               COMMENT '姓名',
  gender      VARCHAR(4)   NOT NULL DEFAULT ''    COMMENT '性别',
  class_name  VARCHAR(50)  NOT NULL               COMMENT '班级',
  major_name  VARCHAR(100) NOT NULL               COMMENT '专业',
  enroll_year INT          NOT NULL               COMMENT '入学年份',
  phone       VARCHAR(20)           DEFAULT NULL  COMMENT '联系电话',
  status      VARCHAR(10)  NOT NULL DEFAULT '在读' COMMENT '学籍状态（在读/演示）',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (student_id),
  KEY idx_students_class (class_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='学生名册';

-- ------------------------------------------------------------
-- 4. 课程库（课程主数据）
-- ------------------------------------------------------------
CREATE TABLE courses (
  course_id   VARCHAR(20)  NOT NULL              COMMENT '课程号',
  course_name VARCHAR(100) NOT NULL              COMMENT '课程名称',
  credit      DECIMAL(3,1) NOT NULL              COMMENT '学分',
  hours       INT          NOT NULL              COMMENT '学时',
  nature      VARCHAR(20)  NOT NULL DEFAULT '专业课' COMMENT '课程性质',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  plan_code   VARCHAR(20)           DEFAULT NULL COMMENT '对应培养方案课程代码',
  PRIMARY KEY (course_id),
  KEY idx_courses_name (course_name),
  KEY idx_courses_plan (plan_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='课程库';

-- ------------------------------------------------------------
-- 5. 开课安排表（课程 o-- 班级 / 学期）
-- ------------------------------------------------------------
CREATE TABLE course_arrangements (
  arrange_id  BIGINT      NOT NULL AUTO_INCREMENT COMMENT '开课编号',
  course_id   VARCHAR(20) NOT NULL                COMMENT '课程号',
  class_name  VARCHAR(50) NOT NULL                COMMENT '开课班级',
  semester    VARCHAR(20) NOT NULL                COMMENT '学期（如 2026-2027-1）',
  is_archived TINYINT(1)  NOT NULL DEFAULT 0      COMMENT '是否归档（1 是 0 否）',
  PRIMARY KEY (arrange_id),
  KEY idx_arrange_class_sem (class_name, semester),
  KEY idx_arrange_course_sem (course_id, semester),
  CONSTRAINT fk_arrange_course  FOREIGN KEY (course_id)  REFERENCES courses (course_id)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='开课安排';

-- ------------------------------------------------------------
-- 6. 成绩表（学生 n--n 课程的联结表，含成绩明细）
-- ------------------------------------------------------------
CREATE TABLE scores (
  score_id    BIGINT       NOT NULL AUTO_INCREMENT COMMENT '成绩编号',
  student_id  VARCHAR(20)  NOT NULL                COMMENT '学号',
  arrange_id  BIGINT       NOT NULL                COMMENT '开课编号',
  usual_score DECIMAL(5,1)          DEFAULT NULL   COMMENT '平时成绩',
  exam_score  DECIMAL(5,1)          DEFAULT NULL   COMMENT '期末成绩',
  total_score DECIMAL(5,1)          DEFAULT NULL   COMMENT '总评成绩',
  gp          DECIMAL(3,1)          DEFAULT NULL   COMMENT '绩点',
  count_gp    TINYINT(1)   NOT NULL DEFAULT 1      COMMENT '是否计入平均学分绩点（1 计入 0 不计入；MOOC/智慧树、体育、国际课程、创新创业实践及无成绩的不计入）',
  status      VARCHAR(10)  NOT NULL DEFAULT '正常' COMMENT '状态（正常/缺考/缓考/作弊/在修）',
  is_archived TINYINT(1)   NOT NULL DEFAULT 0      COMMENT '是否归档（1 是 0 否）',
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (score_id),
  UNIQUE KEY uk_scores_stu_arr (student_id, arrange_id),
  KEY idx_scores_student (student_id),
  KEY idx_scores_arrange (arrange_id),
  CONSTRAINT fk_scores_student FOREIGN KEY (student_id) REFERENCES students (student_id) ON DELETE CASCADE,
  CONSTRAINT fk_scores_arrange FOREIGN KEY (arrange_id) REFERENCES course_arrangements (arrange_id),
  CONSTRAINT ck_scores_status CHECK (status IN ('正常','缺考','缓考','作弊','在修')),
  CONSTRAINT ck_scores_total  CHECK (total_score IS NULL OR (total_score >= 0 AND total_score <= 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='成绩记录';

-- ------------------------------------------------------------
-- 7. 用户档案表（登录账号 1:1 学籍身份）
-- ------------------------------------------------------------
CREATE TABLE user_profiles (
  id         BIGINT      NOT NULL AUTO_INCREMENT COMMENT '档案编号',
  owner_id   VARCHAR(64) NOT NULL                COMMENT '账号标识（对应 users.id）',
  real_name  VARCHAR(50) NOT NULL DEFAULT '新用户' COMMENT '真实姓名',
  role       VARCHAR(10) NOT NULL DEFAULT 'student' COMMENT '角色（student/admin）',
  student_id VARCHAR(20)          DEFAULT NULL   COMMENT '绑定学号',
  phone      VARCHAR(20)          DEFAULT NULL   COMMENT '联系电话',
  demo_mode  TINYINT(1)  NOT NULL DEFAULT 1      COMMENT '演示模式（1 是 0 否）',
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_profiles_owner (owner_id),
  KEY idx_profiles_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='用户档案';

-- ------------------------------------------------------------
-- 8. 操作日志表
-- ------------------------------------------------------------
CREATE TABLE operation_logs (
  log_id       BIGINT       NOT NULL AUTO_INCREMENT COMMENT '日志编号',
  user_id      VARCHAR(64)  NOT NULL                COMMENT '用户标识',
  module       VARCHAR(50)  NOT NULL                COMMENT '模块',
  action       VARCHAR(50)  NOT NULL                COMMENT '操作',
  detail       VARCHAR(255)          DEFAULT NULL   COMMENT '详情',
  ip           VARCHAR(45)           DEFAULT NULL   COMMENT 'IP 地址',
  operate_time DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
  PRIMARY KEY (log_id),
  KEY idx_oplogs_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='操作日志';

-- ------------------------------------------------------------
-- 9. 账号表（登录凭据，与 user_profiles 一对一）
-- ------------------------------------------------------------
CREATE TABLE users (
  id         VARCHAR(32)  NOT NULL                COMMENT '账号标识',
  email      VARCHAR(100)          DEFAULT NULL   COMMENT '邮箱',
  phone      VARCHAR(20)           DEFAULT NULL   COMMENT '手机号',
  pass_hash  VARCHAR(255)          DEFAULT NULL   COMMENT '口令散列（scrypt 加盐）',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '注册时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email),
  UNIQUE KEY uk_users_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='登录账号';

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- 视图
-- ============================================================

-- 视图 1：成绩明细（成绩 / 学生 / 课程 / 开课 四表联结）
CREATE OR REPLACE VIEW v_score_detail AS
SELECT sc.score_id,
       sc.student_id,
       st.name        AS student_name,
       st.class_name,
       c.course_id,
       c.course_name,
       c.credit,
       c.nature       AS course_nature,
       a.semester,
       a.arrange_id,
       sc.usual_score,
       sc.exam_score,
       sc.total_score,
       sc.gp,
       sc.status
  FROM scores sc
  JOIN students           st ON st.student_id = sc.student_id
  JOIN course_arrangements a ON a.arrange_id  = sc.arrange_id
  JOIN courses             c ON c.course_id   = a.course_id;

-- 视图 2：学生学分完成度（按学生聚合已获学分与平均分）
CREATE OR REPLACE VIEW v_student_credit AS
SELECT st.student_id,
       st.name        AS student_name,
       st.class_name,
       COUNT(DISTINCT CASE WHEN sc.total_score >= 60 THEN a.course_id END) AS passed_courses,
       IFNULL(SUM(CASE WHEN sc.total_score >= 60 THEN c.credit ELSE 0 END), 0) AS earned_credits,
       ROUND(AVG(sc.total_score), 1) AS avg_score,
       SUM(CASE WHEN sc.status = '在修' THEN 1 ELSE 0 END) AS studying_count
  FROM students st
  LEFT JOIN scores              sc ON sc.student_id = st.student_id
  LEFT JOIN course_arrangements a  ON a.arrange_id  = sc.arrange_id
  LEFT JOIN courses             c  ON c.course_id   = a.course_id
 GROUP BY st.student_id, st.name, st.class_name;

-- 视图 3：开课安排一览（含课程与选课人数）
CREATE OR REPLACE VIEW v_course_arrange_detail AS
SELECT a.arrange_id,
       a.semester,
       a.class_name,
       c.course_id,
       c.course_name,
       c.credit,
       c.nature,
       a.is_archived,
       COUNT(sc.score_id) AS score_count
  FROM course_arrangements a
  JOIN courses             c  ON c.course_id   = a.course_id
  LEFT JOIN scores         sc ON sc.arrange_id = a.arrange_id
 GROUP BY a.arrange_id, a.semester, a.class_name, c.course_id, c.course_name,
          c.credit, c.nature, a.is_archived;

-- ============================================================
-- 触发器：由数据库自动维护审计字段
-- ============================================================

DROP TRIGGER IF EXISTS trg_scores_before_update;
CREATE TRIGGER trg_scores_before_update
BEFORE UPDATE ON scores FOR EACH ROW
SET NEW.updated_at = IF(NEW.total_score <=> OLD.total_score, NEW.updated_at, NOW());

DROP TRIGGER IF EXISTS trg_profiles_before_update;
CREATE TRIGGER trg_profiles_before_update
BEFORE UPDATE ON user_profiles FOR EACH ROW
SET NEW.updated_at = NOW();

-- ============================================================
-- 学涯拼图 · MySQL 存储函数与存储过程
-- 设计要点：把「成绩导入」「身份注册」「开课归档」等多表事务下沉到
--           数据库层，一次调用完成，避免应用层多次往返与部分提交。
-- 当前登录用户：由后端在事务开始处写入会话变量 @app_uid，
--           存储过程统一通过 fn_current_uid() 读取（对应云端 auth.uid()）。
-- ============================================================

DELIMITER $$

-- ------------------------------------------------------------
-- 函数 1：fn_current_uid  取当前会话登录用户
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_current_uid$$
CREATE FUNCTION fn_current_uid() RETURNS VARCHAR(64)
  READS SQL DATA
  COMMENT '返回当前会话登录用户标识（后端注入的 @app_uid）'
BEGIN
  RETURN NULLIF(@app_uid, '');
END$$

-- ------------------------------------------------------------
-- 函数 2：fn_score_to_gp  百分制成绩 -> 绩点
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_score_to_gp$$
CREATE FUNCTION fn_score_to_gp(p_score DECIMAL(5,1)) RETURNS DECIMAL(3,1)
  DETERMINISTIC
  COMMENT '百分制成绩换算绩点（与前端 scoreToGp 完全一致）'
BEGIN
  RETURN CASE
    WHEN p_score IS NULL THEN NULL
    WHEN p_score >= 90 THEN 4.0
    WHEN p_score >= 85 THEN 3.7
    WHEN p_score >= 82 THEN 3.3
    WHEN p_score >= 78 THEN 3.0
    WHEN p_score >= 75 THEN 2.7
    WHEN p_score >= 72 THEN 2.3
    WHEN p_score >= 68 THEN 2.0
    WHEN p_score >= 64 THEN 1.5
    WHEN p_score >= 60 THEN 1.0
    ELSE 0.0 END;
END$$

-- ------------------------------------------------------------
-- 函数 3：fn_norm_name  课名归一化（与前端 normName 同口径）
--   去空白/星号/间隔点、全角转半角、括号统一、
--   罗马数字（Ⅰ-Ⅻ）/希腊异形（Ιι）/中文数字（一二…九）统一成阿拉伯数字、小写
--   用于导入时「同名课程 / 同名方案条目」的模糊匹配，只做比较、不落库
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_norm_name$$
CREATE FUNCTION fn_norm_name(p VARCHAR(200)) RETURNS VARCHAR(200)
  DETERMINISTIC NO SQL
  COMMENT '课名归一化（全半角/罗马数字/中文数字统一，用于同名匹配）'
BEGIN
  DECLARE s VARCHAR(400);
  SET s = IFNULL(p, '');
  -- 去空白、星号、间隔点
  SET s = REPLACE(s, ' ', '');
  SET s = REPLACE(s, '　', '');
  SET s = REPLACE(s, '＊', '');
  SET s = REPLACE(s, '*', '');
  SET s = REPLACE(s, '·', '');
  SET s = REPLACE(s, '•', '');
  SET s = REPLACE(s, '・', '');
  SET s = REPLACE(s, CHAR(9),  '');
  SET s = REPLACE(s, CHAR(10), '');
  SET s = REPLACE(s, CHAR(13), '');
  -- 全角字母/数字/括号统一；罗马数字、希腊异形、中文数字 → 阿拉伯数字
  SET s = REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       REPLACE(
       s, 'Ａ', 'A'), 'Ｂ', 'B'), 'Ｃ', 'C'), 'Ｄ', 'D'), 'Ｅ', 'E'), 'Ｆ', 'F'), 'Ｇ', 'G'), 'Ｈ', 'H'), 'Ｉ', 'I'), 'Ｊ', 'J'), 'Ｋ', 'K'), 'Ｌ', 'L'), 'Ｍ', 'M'), 'Ｎ', 'N'), 'Ｏ', 'O'), 'Ｐ', 'P'), 'Ｑ', 'Q'), 'Ｒ', 'R'), 'Ｓ', 'S'), 'Ｔ', 'T'), 'Ｕ', 'U'), 'Ｖ', 'V'), 'Ｗ', 'W'), 'Ｘ', 'X'), 'Ｙ', 'Y'), 'Ｚ', 'Z'), 'ａ', 'a'), 'ｂ', 'b'), 'ｃ', 'c'), 'ｄ', 'd'), 'ｅ', 'e'), 'ｆ', 'f'), 'ｇ', 'g'), 'ｈ', 'h'), 'ｉ', 'i'), 'ｊ', 'j'), 'ｋ', 'k'), 'ｌ', 'l'), 'ｍ', 'm'), 'ｎ', 'n'), 'ｏ', 'o'), 'ｐ', 'p'), 'ｑ', 'q'), 'ｒ', 'r'), 'ｓ', 's'), 'ｔ', 't'), 'ｕ', 'u'), 'ｖ', 'v'), 'ｗ', 'w'), 'ｘ', 'x'), 'ｙ', 'y'), 'ｚ', 'z'), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), '（', '('), '）', ')'), 'Ⅰ', '1'), 'Ⅱ', '2'), 'Ⅲ', '3'), 'Ⅳ', '4'), 'Ⅴ', '5'), 'Ⅵ', '6'), 'Ⅶ', '7'), 'Ⅷ', '8'), 'Ⅸ', '9'), 'Ⅹ', 'X'), 'Ⅺ', 'Y'), 'Ⅻ', 'Z'), 'Ι', '1'), 'ι', '1'), '一', '1'), '二', '2'), '三', '3'), '四', '4'), '五', '5'), '六', '6'), '七', '7'), '八', '8'), '九', '9');
  RETURN LOWER(s);
END$$

-- ------------------------------------------------------------
-- 存储过程 1：sp_ensure_course  课程自动建档 + 培养方案映射（导入用）
--   ① 课名按 fn_norm_name 归一化后再比对（全半角/罗马数字/中文数字差异不影响匹配）
--   ② 类别兼容：课程与方案条目同类目，或两类目互为上下级模块，才允许共用
--   ③ 方案条目三步匹配：全方案归一化同名唯一 → 指定类目内复用 → 自动建档（is_generic 占位）
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_ensure_course$$
CREATE PROCEDURE sp_ensure_course(
  IN  p_name   VARCHAR(100),
  IN  p_credit DECIMAL(3,1),
  IN  p_cat    VARCHAR(100),
  IN  p_nature VARCHAR(20),
  OUT o_cid    VARCHAR(20),
  OUT o_err    VARCHAR(255)
)
  COMMENT '课程自动建档 + 培养方案映射（类别优先，导入成绩时调用）'
BEGIN
  DECLARE v_catcode  VARCHAR(20) DEFAULT NULL;
  DECLARE v_pcode    VARCHAR(20) DEFAULT NULL;
  DECLARE v_isparent INT DEFAULT 0;
  DECLARE v_cnt      INT DEFAULT 0;

  SET o_err = NULL;
  SET o_cid = NULL;

  main: BEGIN
    -- 1) 入参校验
    IF p_name IS NULL OR TRIM(p_name) = '' THEN
      SET o_err = '课程名称为空'; LEAVE main;
    END IF;
    IF p_credit IS NULL OR p_credit < 0.5 OR p_credit > 20 THEN
      SET o_err = '学分须在 0.5-20 之间'; LEAVE main;
    END IF;
    IF p_nature IS NULL OR p_nature NOT IN ('必修','选修','指定选修') THEN
      SET o_err = '课程性质只能是 必修/选修/指定选修'; LEAVE main;
    END IF;

    -- 2) 定位培养方案类目（名称或代码皆可）。可归类的目标：
    --    叶子类目 / 已有方案条目的类目 / 有学分要求且子类都没有学分要求的模块
    --    （如「开放性专业选修课程」27 学分，允许直接归到大类）
    SELECT c.code INTO v_catcode
      FROM plan_categories c
     WHERE (c.name = TRIM(p_cat)
            OR UPPER(c.code) = UPPER(TRIM(IFNULL(p_cat, ''))))
       AND (NOT EXISTS (SELECT 1 FROM plan_categories c2 WHERE c2.parent_code = c.code)
            OR EXISTS (SELECT 1 FROM plan_courses pc WHERE pc.category_code = c.code)
            OR (c.required_credits IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM plan_categories c3
                                 WHERE c3.parent_code = c.code
                                   AND c3.required_credits IS NOT NULL)))
     LIMIT 1;

    IF v_catcode IS NULL THEN
      SELECT COUNT(*) INTO v_isparent
        FROM plan_categories c
       WHERE (c.name = TRIM(IFNULL(p_cat, ''))
              OR UPPER(c.code) = UPPER(TRIM(IFNULL(p_cat, ''))))
         AND EXISTS (SELECT 1 FROM plan_categories c2 WHERE c2.parent_code = c.code);
      IF v_isparent > 0 THEN
        SET o_err = CONCAT('课程类别「', IFNULL(p_cat, ''), '」是模块名，请填到具体子类别（如：体育类课程、专业核心课程）');
      ELSE
        SET o_err = CONCAT('课程类别「', IFNULL(p_cat, '(空)'), '」不存在');
      END IF;
      LEAVE main;
    END IF;

    -- 3) 课程行：归一化课名匹配，原生课程行（非 IMP 自动建档）优先。
    --    但若它现挂的方案条目类目与本次「课程类别」不兼容（同名不同课，
    --    如交叉类的「公共组织管理」 vs 学生选的国际课程），则不共用、另建 IMP 行。
    --    类别兼容 = 条目类目就是目标类目，或两类目互为上下级模块关系。
    SELECT c.course_id INTO o_cid
      FROM courses c
      LEFT JOIN plan_courses    p    ON p.code    = c.plan_code
      LEFT JOIN plan_categories pcat ON pcat.code = p.category_code
      LEFT JOIN plan_categories tcat ON tcat.code = v_catcode
     WHERE fn_norm_name(c.course_name) = fn_norm_name(TRIM(p_name))
       AND (c.plan_code IS NULL
            OR p.category_code  = v_catcode
            OR pcat.parent_code = v_catcode
            OR tcat.parent_code = p.category_code)
     ORDER BY (c.course_id NOT LIKE 'IMP%') DESC, c.course_id
     LIMIT 1;

    IF o_cid IS NULL THEN
      -- 课程号：IMP + 课名#学分#类目 的 MD5 前 10 位，保证同名同学分同类别复用同一条记录
      SET o_cid = CONCAT('IMP', UPPER(SUBSTRING(MD5(CONCAT(LOWER(TRIM(p_name)), '#', p_credit, '#', v_catcode)), 1, 10)));
      INSERT IGNORE INTO courses(course_id, course_name, credit, hours, nature)
      VALUES (o_cid, TRIM(p_name), p_credit, ROUND(p_credit * 16), p_nature);
      IF NOT EXISTS (SELECT 1 FROM courses WHERE course_id = o_cid) THEN
        -- 已被插入（重复执行）：取一个类别兼容的同名行；再不行兜底取任意同名行
        SELECT c.course_id INTO o_cid
          FROM courses c
          LEFT JOIN plan_courses    p    ON p.code    = c.plan_code
          LEFT JOIN plan_categories pcat ON pcat.code = p.category_code
          LEFT JOIN plan_categories tcat ON tcat.code = v_catcode
         WHERE fn_norm_name(c.course_name) = fn_norm_name(TRIM(p_name))
           AND (c.plan_code IS NULL
                OR p.category_code  = v_catcode
                OR pcat.parent_code = v_catcode
                OR tcat.parent_code = p.category_code)
         ORDER BY (c.course_id NOT LIKE 'IMP%') DESC, c.course_id
         LIMIT 1;
        IF o_cid IS NULL THEN
          SELECT c.course_id INTO o_cid
            FROM courses c
           WHERE fn_norm_name(c.course_name) = fn_norm_name(TRIM(p_name))
           ORDER BY (c.course_id NOT LIKE 'IMP%') DESC, c.course_id
           LIMIT 1;
        END IF;
      END IF;
    END IF;

    -- 4) 方案条目匹配三步
    --    ① 全方案（非自动建档）归一化同名 且 类别兼容 → 唯一直接认它（培养方案是权威）
    SET v_pcode = NULL;
    SELECT COUNT(*) INTO v_cnt
      FROM plan_courses pc
      LEFT JOIN plan_categories pcat ON pcat.code = pc.category_code
      LEFT JOIN plan_categories tcat ON tcat.code = v_catcode
     WHERE pc.code NOT LIKE 'IMP%'
       AND fn_norm_name(pc.name) = fn_norm_name(TRIM(p_name))
       AND (pc.category_code  = v_catcode
            OR pcat.parent_code = v_catcode
            OR tcat.parent_code = pc.category_code);
    IF v_cnt = 1 THEN
      SELECT pc.code INTO v_pcode
        FROM plan_courses pc
        LEFT JOIN plan_categories pcat ON pcat.code = pc.category_code
        LEFT JOIN plan_categories tcat ON tcat.code = v_catcode
       WHERE pc.code NOT LIKE 'IMP%'
         AND fn_norm_name(pc.name) = fn_norm_name(TRIM(p_name))
         AND (pc.category_code  = v_catcode
              OR pcat.parent_code = v_catcode
              OR tcat.parent_code = pc.category_code)
       ORDER BY pc.code LIMIT 1;
    ELSEIF v_cnt > 1 THEN
      -- 同名多条：优先方案指定类目里的那条
      SELECT pc.code INTO v_pcode
        FROM plan_courses pc
        LEFT JOIN plan_categories pcat ON pcat.code = pc.category_code
        LEFT JOIN plan_categories tcat ON tcat.code = v_catcode
       WHERE pc.code NOT LIKE 'IMP%'
         AND fn_norm_name(pc.name) = fn_norm_name(TRIM(p_name))
         AND (pc.category_code  = v_catcode
              OR pcat.parent_code = v_catcode
              OR tcat.parent_code = pc.category_code)
       ORDER BY (pc.category_code = v_catcode) DESC, pc.code LIMIT 1;
    END IF;
    --    ② 指定类目内按归一化名复用（课名在方案里没有 → 找占位/既有条）
    IF v_pcode IS NULL THEN
      SELECT pc.code INTO v_pcode
        FROM plan_courses pc
       WHERE fn_norm_name(pc.name) = fn_norm_name(TRIM(p_name))
         AND pc.category_code = v_catcode
       ORDER BY pc.code LIMIT 1;
    END IF;
    --    ③ 自动建档（is_generic 占位条，前端按「类别优先」规则认定）
    IF v_pcode IS NULL THEN
      SET v_pcode = CONCAT('IMP', UPPER(SUBSTRING(MD5(CONCAT(LOWER(TRIM(p_name)), '#', v_catcode)), 1, 10)));
      INSERT IGNORE INTO plan_courses(code, name, credits, sem_from, sem_to,
                                      category_code, nature, is_generic, note)
      VALUES (v_pcode, TRIM(p_name), p_credit, 1, 8, v_catcode, p_nature, 1, '批量导入自动创建');
      IF NOT EXISTS (SELECT 1 FROM plan_courses WHERE code = v_pcode) THEN
        SELECT pc.code INTO v_pcode
          FROM plan_courses pc
         WHERE fn_norm_name(pc.name) = fn_norm_name(TRIM(p_name))
           AND pc.category_code = v_catcode
         ORDER BY pc.code LIMIT 1;
      END IF;
    END IF;

    -- 5) 课程 → 方案条目：跟随最新导入的类目（旧指针类目不一致时更新）
    UPDATE courses c
      LEFT JOIN plan_courses p ON p.code = c.plan_code
       SET c.plan_code = v_pcode
     WHERE c.course_id = o_cid
       AND (c.plan_code IS NULL OR IFNULL(p.category_code, '') <> v_catcode);
  END main;
END$$
-- ------------------------------------------------------------
-- 存储过程 2：sp_import_student_courses  学生自助导入选课 / 成绩
--   入参：JSON 数组 [{"sem","name","credit","cat","nature","score","state"}, ...]
--   出参：单行结果集 {ok, created_courses, created_arrangements, errors}
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_import_student_courses$$
CREATE PROCEDURE sp_import_student_courses(IN p_rows JSON)
  COMMENT '学生自助导入选课与成绩（逐行校验，返回成功条数与错误清单）'
BEGIN
  DECLARE v_uid      VARCHAR(64);
  DECLARE v_sid      VARCHAR(20);
  DECLARE v_cls      VARCHAR(50);
  DECLARE v_n        INT DEFAULT 0;
  DECLARE i          INT DEFAULT 0;
  DECLARE v_row      JSON;
  DECLARE v_sem      VARCHAR(20);
  DECLARE v_name     VARCHAR(100);
  DECLARE v_cat      VARCHAR(100);
  DECLARE v_nature   VARCHAR(20);
  DECLARE v_state    VARCHAR(20);
  DECLARE v_credit   DECIMAL(3,1);
  DECLARE v_score    DECIMAL(5,1);
  DECLARE v_cid      VARCHAR(20);
  DECLARE v_cerr     VARCHAR(255);
  DECLARE v_aid      BIGINT;
  DECLARE v_status   VARCHAR(10);
  DECLARE v_total    DECIMAL(5,1);
  DECLARE v_count_gp TINYINT(1);
  DECLARE v_tmp2     VARCHAR(16);
  DECLARE v_existed  INT DEFAULT 0;
  DECLARE v_ok       INT DEFAULT 0;
  DECLARE v_courses  INT DEFAULT 0;
  DECLARE v_arrs     INT DEFAULT 0;
  DECLARE v_errors   JSON DEFAULT JSON_ARRAY();

  SET v_uid = fn_current_uid();
  IF v_uid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '需要先登录';
  END IF;

  SET v_sid = NULL; SET v_cls = NULL;
  SELECT p.student_id, s.class_name INTO v_sid, v_cls
    FROM user_profiles p
    JOIN students s ON s.student_id = p.student_id
   WHERE p.owner_id = v_uid AND p.role IN ('student','admin')
   LIMIT 1;
  IF v_sid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '当前账号未绑定学生身份（或学籍缺少班级信息）';
  END IF;

  SET v_n = IFNULL(JSON_LENGTH(p_rows), 0);
  WHILE i < v_n DO
    SET v_row = JSON_EXTRACT(p_rows, CONCAT('$[', i, ']'));

    rw: BEGIN
      DECLARE v_msg VARCHAR(255);
      -- 注意：这里必须是 EXIT HANDLER。MySQL 不允许在 handler 体内 LEAVE 它所属的那个
      -- 标签块（会报 1308），而 EXIT HANDLER 在异常时本就会退出所在 BEGIN...END 块，
      -- 效果与「捕获异常 → 跳出本行处理」完全一致，下一行继续。
      DECLARE EXIT HANDLER FOR SQLEXCEPTION
      BEGIN
        GET DIAGNOSTICS CONDITION 1 v_msg = MESSAGE_TEXT;
        SET v_errors = JSON_ARRAY_APPEND(v_errors, '$', CONCAT('第', i + 1, '行：', v_msg));
      END;

      -- 取字段：JSON 里的 null 与「键缺失」都归一成空串，
      -- 否则 JSON_UNQUOTE 会把 JSON null 变成字符串 'null' 混进取值里
      SET v_sem    = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(v_row, '$.sem')), ''));
      SET v_name   = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(v_row, '$.name')), ''));
      SET v_cat    = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(v_row, '$.cat')), ''));
      SET v_nature = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(v_row, '$.nature')), ''));
      IF v_sem    = 'null' THEN SET v_sem    = ''; END IF;
      IF v_name   = 'null' THEN SET v_name   = ''; END IF;
      IF v_cat    = 'null' THEN SET v_cat    = ''; END IF;
      IF v_nature = 'null' THEN SET v_nature = ''; END IF;
      SET v_nature = IFNULL(NULLIF(v_nature, ''), '必修');
      -- 模板「状态」列：完成 / 在修（再修同义）。主要用于认定型实践课的完成认定
      SET v_state  = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(v_row, '$.state')), ''));
      IF v_state = 'null' THEN SET v_state = ''; END IF;
      SET v_credit = NULL;
      SET v_score  = NULL;
      num: BEGIN
        DECLARE v_tmp VARCHAR(32);
        SET v_tmp = NULLIF(NULLIF(TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(v_row, '$.credit')), '')), ''), 'null');
        IF v_tmp IS NOT NULL THEN SET v_credit = CAST(v_tmp AS DECIMAL(3,1)); END IF;
        SET v_tmp = NULLIF(NULLIF(TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(v_row, '$.score')), '')), ''), 'null');
        IF v_tmp IS NOT NULL THEN SET v_score = CAST(v_tmp AS DECIMAL(5,1)); END IF;
      END num;

      -- 行校验
      IF v_sem NOT REGEXP '^[0-9]{4}-[0-9]{4}(-[12])?$' THEN
        SET v_errors = JSON_ARRAY_APPEND(v_errors, '$',
          CONCAT('第', i + 1, '行「', v_name, '」：学期格式应为 2025-2026-2（末位 1 秋 2 春）或 2024-2028（跨学年实践）'));
        LEAVE rw;
      END IF;
      IF v_name = '' THEN
        SET v_errors = JSON_ARRAY_APPEND(v_errors, '$', CONCAT('第', i + 1, '行：课程名称为空'));
        LEAVE rw;
      END IF;
      IF v_score IS NOT NULL AND (v_score < 0 OR v_score > 100) THEN
        SET v_errors = JSON_ARRAY_APPEND(v_errors, '$',
          CONCAT('第', i + 1, '行「', v_name, '」：成绩须在 0-100 之间（留空表示在修）'));
        LEAVE rw;
      END IF;

      -- 课程建档
      SELECT COUNT(*) INTO v_existed FROM courses WHERE LOWER(course_name) = LOWER(v_name);
      CALL sp_ensure_course(v_name, v_credit, v_cat, v_nature, v_cid, v_cerr);
      IF v_cerr IS NOT NULL THEN
        SET v_errors = JSON_ARRAY_APPEND(v_errors, '$', CONCAT('第', i + 1, '行「', v_name, '」：', v_cerr));
        LEAVE rw;
      END IF;
      IF v_existed = 0 THEN SET v_courses = v_courses + 1; END IF;

      -- 开课安排（同学期同班级复用同一条）
      SET v_aid = NULL;
      SELECT arrange_id INTO v_aid FROM course_arrangements
       WHERE course_id = v_cid AND semester = v_sem AND class_name = v_cls LIMIT 1;
      IF v_aid IS NULL THEN
        INSERT INTO course_arrangements(course_id, class_name, semester, is_archived)
        VALUES (v_cid, v_cls, v_sem, 0);
        SET v_aid = LAST_INSERT_ID();
        SET v_arrs = v_arrs + 1;
      END IF;

      -- 成绩写入（同一门课重复导入则覆盖）
      -- 是否计入平均学分绩点：行内 count_gp 优先（缺省计入），且无成绩一律不计入
      -- （与 PostgreSQL 版 save_student_score 的「COALESCE(count_gp,true) AND score IS NOT NULL」一致）
      SET v_count_gp = IF(v_score IS NULL, 0, 1);
      SET v_tmp2 = NULLIF(NULLIF(LOWER(TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(v_row, '$.count_gp')), ''))), ''), 'null');
      IF v_tmp2 IS NOT NULL THEN
        SET v_count_gp = IF(v_tmp2 IN ('true','1','yes'), 1, 0);
        IF v_score IS NULL THEN SET v_count_gp = 0; END IF;
      END IF;
      IF v_score IS NULL THEN
        SET v_total = NULL;
        -- 「完成」状态：认定型实践课（美育/志愿/社会实践）或无绩点模式导入的已结业课
        -- —— 学分认定完成，成绩与绩点均不入库；其余留空成绩一律按在修
        IF v_state IN ('完成','已修','已认定') THEN
          SET v_status = '正常';
        ELSE
          SET v_status = '在修';
        END IF;
      ELSE
        SET v_status = '正常'; SET v_total = v_score;
      END IF;

      INSERT INTO scores(student_id, arrange_id, usual_score, exam_score, total_score,
                        gp, count_gp, status, is_archived, updated_at)
      VALUES (v_sid, v_aid, NULL, NULL, v_total, fn_score_to_gp(v_total), v_count_gp, v_status, 0, NOW()) AS nv
      ON DUPLICATE KEY UPDATE
        usual_score = NULL,
        exam_score  = NULL,
        total_score = nv.total_score,
        gp          = nv.gp,
        count_gp    = nv.count_gp,
        status      = nv.status,
        is_archived = 0,
        updated_at  = NOW();

      SET v_ok = v_ok + 1;
    END rw;

    SET i = i + 1;
  END WHILE;

  SELECT JSON_OBJECT('ok', v_ok,
                     'created_courses', v_courses,
                     'created_arrangements', v_arrs,
                     'errors', v_errors) AS r;
END$$

-- ------------------------------------------------------------
-- 存储过程 3：sp_register_identity  注册 / 切换身份
--   学生：学号必须在 students 名册内，姓名以名册为准
--   管理员：直接建档；学生端不含教师身份
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_register_identity$$
CREATE PROCEDURE sp_register_identity(
  IN p_role        VARCHAR(10),
  IN p_real_name   VARCHAR(50),
  IN p_identity    VARCHAR(20),
  IN p_class_name  VARCHAR(50),
  IN p_major_name  VARCHAR(100),
  IN p_title       VARCHAR(50),
  IN p_department  VARCHAR(100)
)
  COMMENT '注册 / 切换身份（学生 · 管理员），返回最新档案行'
BEGIN
  DECLARE v_uid         VARCHAR(64);
  DECLARE v_sno         VARCHAR(20);
  DECLARE v_name        VARCHAR(50);
  DECLARE v_roster_name VARCHAR(50);
  DECLARE v_cnt         INT DEFAULT 0;

  SET v_uid = fn_current_uid();
  IF v_uid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '需要先登录';
  END IF;
  IF p_role NOT IN ('student','admin') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '无效身份类型（学生端只支持学生 / 管理员）';
  END IF;

  SET v_sno  = TRIM(IFNULL(p_identity, ''));
  SET v_name = NULLIF(TRIM(IFNULL(p_real_name, '')), '');

  IF p_role = 'admin' THEN
    SET v_name = IFNULL(v_name, '系统管理员');

  ELSEIF p_role = 'student' THEN
    IF v_sno = '' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '请填写学号';
    END IF;
    -- 学号必须能在本专业名册中找到
    SET v_roster_name = NULL;
    SELECT s.name INTO v_roster_name FROM students s WHERE s.student_id = v_sno LIMIT 1;
    IF v_roster_name IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '学号不在本专业名单内，请核对后重新填写';
    END IF;
    -- 演示学生（status='演示'）允许被多个账号绑定，便于演示
    SELECT COUNT(*) INTO v_cnt FROM user_profiles u
     WHERE u.student_id = v_sno AND u.owner_id <> v_uid;
    IF v_cnt > 0 THEN
      SELECT COUNT(*) INTO v_cnt FROM students s
       WHERE s.student_id = v_sno AND s.status = '演示';
      IF v_cnt = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '该学号已被其他账号绑定';
      END IF;
    END IF;
    SET v_name = v_roster_name;    -- 姓名一律以名册为准
  END IF;

  INSERT INTO user_profiles(owner_id, real_name, role, student_id, demo_mode)
  VALUES (v_uid, IFNULL(v_name, '新用户'), p_role,
          CASE WHEN p_role = 'student' THEN v_sno ELSE NULL END, 1) AS nv
  ON DUPLICATE KEY UPDATE
    real_name  = nv.real_name,
    role       = nv.role,
    student_id = nv.student_id,
    demo_mode  = 1,
    updated_at = NOW();

  SELECT * FROM user_profiles WHERE owner_id = v_uid;
END$$

-- ------------------------------------------------------------
-- 存储过程 5：sp_save_student_score  单条保存成绩（新增或修改）
--   改了课程或学期时自动迁移到新的开课安排（先删旧记录再写新记录）
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_save_student_score$$
CREATE PROCEDURE sp_save_student_score(IN p_row JSON)
  COMMENT '单条保存成绩（新增或修改），返回 {ok, score_id}'
BEGIN
  DECLARE v_uid      VARCHAR(64);
  DECLARE v_sid      VARCHAR(20);
  DECLARE v_cls      VARCHAR(50);
  DECLARE v_id       BIGINT DEFAULT NULL;
  DECLARE v_old_aid  BIGINT DEFAULT NULL;
  DECLARE v_sem      VARCHAR(20);
  DECLARE v_name     VARCHAR(100);
  DECLARE v_cat      VARCHAR(100);
  DECLARE v_nature   VARCHAR(20);
  DECLARE v_credit   DECIMAL(3,1);
  DECLARE v_score    DECIMAL(5,1);
  DECLARE v_count_gp TINYINT(1);
  DECLARE v_cid      VARCHAR(20);
  DECLARE v_cerr     VARCHAR(255);
  DECLARE v_aid      BIGINT;
  DECLARE v_status   VARCHAR(10);
  DECLARE v_new_id   BIGINT;
  DECLARE v_tmp      VARCHAR(64);

  SET v_uid = fn_current_uid();
  IF v_uid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '需要先登录';
  END IF;
  SET v_sid = NULL; SET v_cls = NULL;
  SELECT p.student_id, s.class_name INTO v_sid, v_cls
    FROM user_profiles p
    JOIN students s ON s.student_id = p.student_id
   WHERE p.owner_id = v_uid AND p.role IN ('student','admin')
   LIMIT 1;
  IF v_sid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '当前账号未绑定学生身份';
  END IF;

  -- 取字段（JSON null 与键缺失都归一成空串）
  SET v_tmp = NULLIF(NULLIF(TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(p_row, '$.score_id')), '')), ''), 'null');
  IF v_tmp IS NOT NULL THEN SET v_id = CAST(v_tmp AS UNSIGNED); END IF;
  SET v_sem    = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(p_row, '$.sem')), ''));
  SET v_name   = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(p_row, '$.name')), ''));
  SET v_cat    = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(p_row, '$.cat')), ''));
  SET v_nature = TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(p_row, '$.nature')), ''));
  IF v_sem = 'null' THEN SET v_sem = ''; END IF;
  IF v_name = 'null' THEN SET v_name = ''; END IF;
  IF v_cat = 'null' THEN SET v_cat = ''; END IF;
  SET v_nature = IFNULL(NULLIF(v_nature, ''), '必修');
  SET v_credit = NULL; SET v_score = NULL;
  num: BEGIN
    DECLARE v_num VARCHAR(32);
    SET v_num = NULLIF(NULLIF(TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(p_row, '$.credit')), '')), ''), 'null');
    IF v_num IS NOT NULL THEN SET v_credit = CAST(v_num AS DECIMAL(3,1)); END IF;
    SET v_num = NULLIF(NULLIF(TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(p_row, '$.score')), '')), ''), 'null');
    IF v_num IS NOT NULL THEN SET v_score = CAST(v_num AS DECIMAL(5,1)); END IF;
  END num;
  -- 是否计入绩点：缺省计入，且无成绩一律不计入
  SET v_count_gp = IF(v_score IS NULL, 0, 1);
  SET v_tmp = NULLIF(NULLIF(LOWER(TRIM(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(p_row, '$.count_gp')), ''))), ''), 'null');
  IF v_tmp IS NOT NULL THEN
    SET v_count_gp = IF(v_tmp IN ('true','1','yes'), 1, 0);
    IF v_score IS NULL THEN SET v_count_gp = 0; END IF;
  END IF;

  -- 校验
  IF v_sem NOT REGEXP '^[0-9]{4}-[0-9]{4}(-[12])?$' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '学期格式应为 2025-2026-2（末位 1 秋 2 春）或 2024-2028（跨学年实践）';
  END IF;
  IF v_name = '' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '课程名称不能为空';
  END IF;
  IF v_score IS NOT NULL AND (v_score < 0 OR v_score > 100) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '成绩须在 0-100 之间（留空表示在修）';
  END IF;
  IF v_id IS NOT NULL THEN
    SELECT s.arrange_id INTO v_old_aid
      FROM scores s
     WHERE s.score_id = v_id AND s.student_id = v_sid
     LIMIT 1;
    IF v_old_aid IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '记录不存在或不属于当前账号';
    END IF;
  END IF;

  -- 课程自动建档 + 培养方案映射
  CALL sp_ensure_course(v_name, v_credit, v_cat, v_nature, v_cid, v_cerr);
  IF v_cerr IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_cerr;
  END IF;

  -- 开课安排（同学期同班级复用同一条）
  SET v_aid = NULL;
  SELECT arrange_id INTO v_aid FROM course_arrangements
   WHERE course_id = v_cid AND semester = v_sem AND class_name = v_cls
   LIMIT 1;
  IF v_aid IS NULL THEN
    INSERT INTO course_arrangements(course_id, class_name, semester, is_archived)
    VALUES (v_cid, v_cls, v_sem, 0);
    SET v_aid = LAST_INSERT_ID();
  END IF;

  IF v_score IS NULL THEN SET v_status = '在修'; ELSE SET v_status = '正常'; END IF;

  -- 改了课程或学期 → 新旧不是同一条安排：先删旧记录再写新记录
  IF v_id IS NOT NULL AND v_old_aid <> v_aid THEN
    DELETE FROM scores WHERE score_id = v_id AND student_id = v_sid;
  END IF;

  INSERT INTO scores(student_id, arrange_id, usual_score, exam_score, total_score,
                     gp, count_gp, status, is_archived, updated_at)
  VALUES (v_sid, v_aid, NULL, NULL, v_score, fn_score_to_gp(v_score), v_count_gp, v_status, 0, NOW()) AS nv
  ON DUPLICATE KEY UPDATE
    usual_score = NULL,
    exam_score  = NULL,
    total_score = nv.total_score,
    gp          = nv.gp,
    count_gp    = nv.count_gp,
    status      = nv.status,
    is_archived = 0,
    updated_at  = NOW();

  SELECT score_id INTO v_new_id FROM scores
   WHERE student_id = v_sid AND arrange_id = v_aid
   LIMIT 1;
  SELECT JSON_OBJECT('ok', TRUE, 'score_id', v_new_id) AS r;
END$$

-- ------------------------------------------------------------
-- 存储过程 6：sp_update_student_score  快速修改
--   只改总评成绩与「是否计入平均学分绩点」，绩点按成绩自动换算
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_update_student_score$$
CREATE PROCEDURE sp_update_student_score(
  IN p_score_id  BIGINT,
  IN p_score     DECIMAL(5,1),
  IN p_count_gp  TINYINT(1)
)
  COMMENT '快速修改单条成绩与绩点开关'
BEGIN
  DECLARE v_uid VARCHAR(64);
  DECLARE v_sid VARCHAR(20);
  DECLARE v_n   INT DEFAULT 0;

  SET v_uid = fn_current_uid();
  IF v_uid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '需要先登录';
  END IF;
  SELECT p.student_id INTO v_sid FROM user_profiles p
   WHERE p.owner_id = v_uid AND p.role IN ('student','admin')
   LIMIT 1;
  IF v_sid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '当前账号未绑定学生身份';
  END IF;
  IF p_score IS NOT NULL AND (p_score < 0 OR p_score > 100) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '成绩须在 0-100 之间（留空表示在修）';
  END IF;

  -- 先确认记录存在且属于当前账号（UPDATE 的 ROW_COUNT 只统计「值有变化」的行，
  -- 重复保存同一分数时不会变行，不能用它判断归属）
  SELECT COUNT(*) INTO v_n FROM scores
   WHERE score_id = p_score_id AND student_id = v_sid;
  IF v_n = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '记录不存在或不属于当前账号';
  END IF;

  UPDATE scores SET
    total_score = p_score,
    gp          = fn_score_to_gp(p_score),
    count_gp    = IF(IFNULL(p_count_gp, 0) = 1 AND p_score IS NOT NULL, 1, 0),
    status      = IF(p_score IS NULL, '在修', '正常'),
    updated_at  = NOW()
  WHERE score_id = p_score_id AND student_id = v_sid;
  SELECT JSON_OBJECT('ok', TRUE, 'score_id', p_score_id) AS r;
END$$

-- ------------------------------------------------------------
-- 存储过程 7：sp_gc_orphan_placeholders  占位条目垃圾回收
--   删课之后，清理导入自动创建、且已无任何成绩引用的课程行与方案占位条目
--   （只动 course_id 形如 IMP... 的自动建档行，以及 note='批量导入自动创建' 的
--     is_generic 方案行，绝不碰培养方案原生条目和真实课程）
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_gc_orphan_placeholders$$
CREATE PROCEDURE sp_gc_orphan_placeholders(OUT o_removed INT)
  COMMENT '清理无引用的自动建档课程行与方案占位条目'
BEGIN
  -- ① 自动建档课程行：已无任何成绩引用 → 删除（开课安排有 ON DELETE CASCADE，会一并清掉）
  DELETE c FROM courses c
   WHERE c.course_id LIKE 'IMP%'
     AND NOT EXISTS (SELECT 1 FROM course_arrangements a
                      JOIN scores s ON s.arrange_id = a.arrange_id
                     WHERE a.course_id = c.course_id);
  -- ② 自动创建的方案占位条目：已无课程引用 → 删除
  DELETE p FROM plan_courses p
   WHERE p.is_generic = 1
     AND p.note = '批量导入自动创建'
     AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.plan_code = p.code);
  SET o_removed = ROW_COUNT();
END$$

-- ------------------------------------------------------------
-- 存储过程 8：sp_delete_student_score  删除一条自己的修课记录
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_delete_student_score$$
CREATE PROCEDURE sp_delete_student_score(IN p_score_id BIGINT)
  COMMENT '删除自己的修课记录，并触发占位条目垃圾回收'
BEGIN
  DECLARE v_uid VARCHAR(64);
  DECLARE v_sid VARCHAR(20);
  DECLARE v_n   INT DEFAULT 0;
  DECLARE v_gc  INT DEFAULT 0;

  SET v_uid = fn_current_uid();
  IF v_uid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '需要先登录';
  END IF;
  SELECT p.student_id INTO v_sid FROM user_profiles p
   WHERE p.owner_id = v_uid AND p.role IN ('student','admin')
   LIMIT 1;
  IF v_sid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '当前账号未绑定学生身份';
  END IF;

  DELETE FROM scores WHERE score_id = p_score_id AND student_id = v_sid;
  SET v_n = ROW_COUNT();
  IF v_n = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '记录不存在或不属于当前账号';
  END IF;

  CALL sp_gc_orphan_placeholders(v_gc);
  SELECT JSON_OBJECT('ok', TRUE, 'deleted', v_n, 'gc', v_gc) AS r;
END$$

-- ------------------------------------------------------------
-- 存储过程 9：sp_batch_update_score_gp  批量设置「是否计入平均学分绩点」
--   在修（没成绩）的记录无法计入，自动跳过并在返回值里报告 skipped
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_batch_update_score_gp$$
CREATE PROCEDURE sp_batch_update_score_gp(
  IN p_ids      JSON,
  IN p_count_gp TINYINT(1)
)
  COMMENT '批量设置勾选记录的绩点开关，返回 {ok, updated, skipped}'
BEGIN
  DECLARE v_uid    VARCHAR(64);
  DECLARE v_sid    VARCHAR(20);
  DECLARE v_n      INT DEFAULT 0;
  DECLARE v_skip   INT DEFAULT 0;
  DECLARE v_jn     INT DEFAULT 0;
  DECLARE v_j      INT DEFAULT 0;
  DECLARE v_id     BIGINT;
  DECLARE v_idlist TEXT DEFAULT '';

  SET v_uid = fn_current_uid();
  IF v_uid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '需要先登录';
  END IF;
  SELECT p.student_id INTO v_sid FROM user_profiles p
   WHERE p.owner_id = v_uid AND p.role IN ('student','admin')
   LIMIT 1;
  IF v_sid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '当前账号未绑定学生身份';
  END IF;
  SET v_jn = IFNULL(JSON_LENGTH(p_ids), 0);
  IF v_jn = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '还没有勾选任何记录';
  END IF;

  WHILE v_j < v_jn DO
    SET v_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(p_ids, CONCAT('$[', v_j, ']'))) AS UNSIGNED);
    UPDATE scores SET
      count_gp   = IF(IFNULL(p_count_gp, 0) = 1 AND total_score IS NOT NULL, 1, 0),
      updated_at = NOW()
    WHERE score_id = v_id AND student_id = v_sid;
    SET v_idlist = CONCAT(v_idlist, IF(v_j = 0, '', ','), v_id);
    SET v_j = v_j + 1;
  END WHILE;

  -- ROW_COUNT 只统计「值有变化」的行，因此归属校验与计数都按 ID 清单回查：
  -- 勾选记录里不存在或不属于当前账号的 → 报错；有成绩的 → updated，在修的 → skipped
  SELECT COUNT(*) INTO v_n FROM scores
   WHERE student_id = v_sid
     AND FIND_IN_SET(CAST(score_id AS CHAR), v_idlist) > 0;
  IF v_n = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '记录不存在或不属于当前账号';
  END IF;

  -- 在修（没成绩）的记录无法计入，统计为 skipped
  SELECT COUNT(*) INTO v_skip FROM scores
   WHERE student_id = v_sid
     AND total_score IS NULL
     AND FIND_IN_SET(CAST(score_id AS CHAR), v_idlist) > 0;

  SELECT JSON_OBJECT('ok', TRUE, 'updated', v_n - v_skip, 'skipped', v_skip) AS r;
END$$

-- ------------------------------------------------------------
-- 存储过程 10：sp_batch_delete_scores  批量删除自己的修课记录
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_batch_delete_scores$$
CREATE PROCEDURE sp_batch_delete_scores(IN p_ids JSON)
  COMMENT '批量删除勾选的修课记录，并触发占位条目垃圾回收'
BEGIN
  DECLARE v_uid VARCHAR(64);
  DECLARE v_sid VARCHAR(20);
  DECLARE v_n   INT DEFAULT 0;
  DECLARE v_gc  INT DEFAULT 0;
  DECLARE v_jn  INT DEFAULT 0;
  DECLARE v_j   INT DEFAULT 0;
  DECLARE v_id  BIGINT;

  SET v_uid = fn_current_uid();
  IF v_uid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '需要先登录';
  END IF;
  SELECT p.student_id INTO v_sid FROM user_profiles p
   WHERE p.owner_id = v_uid AND p.role IN ('student','admin')
   LIMIT 1;
  IF v_sid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '当前账号未绑定学生身份';
  END IF;
  SET v_jn = IFNULL(JSON_LENGTH(p_ids), 0);
  IF v_jn = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '还没有勾选任何记录';
  END IF;

  WHILE v_j < v_jn DO
    SET v_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(p_ids, CONCAT('$[', v_j, ']'))) AS UNSIGNED);
    DELETE FROM scores WHERE score_id = v_id AND student_id = v_sid;
    SET v_n = v_n + ROW_COUNT();
    SET v_j = v_j + 1;
  END WHILE;
  IF v_n = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '记录不存在或不属于当前账号';
  END IF;

  CALL sp_gc_orphan_placeholders(v_gc);
  SELECT JSON_OBJECT('ok', TRUE, 'deleted', v_n, 'gc', v_gc) AS r;
END$$

DELIMITER ;

-- ============================================================
-- 学涯拼图  数据快照（MySQL 版）
-- 由本机自建版 PostgreSQL 快照 data.sql 转换而来
-- 内容：plan_categories / plan_courses / courses / course_arrangements
--       / students / scores
-- 说明：成绩只保留演示账号（0000000000000 李华）名下的一套示例数据；
--       真实学号下没有示例成绩，账号由页面自助注册。
-- ============================================================

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;
SET FOREIGN_KEY_CHECKS = 1;

-- 学涯拼图 · 数据快照（自建 PostgreSQL）
-- 内容：courses / course_arrangements / students / scores
-- 生成：2026-10-14（学号名册更新：信管 2024 级 71 人 + 1 个演示账号）
-- 说明：成绩只保留李华（0000000000000）名下的一套示例数据；真实学号下没有示例成绩。
-- 账号由页面自助注册（本机版验证码直接显示），故不包含 users / user_profiles

--
-- Data for Name: courses; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('202300006005', '大学生心理发展与指导', 1.0, 16, '指定选修', '2026-10-12 18:05:39', '202300006005');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('202300008001', '大学生心理素质拓展', 1.0, 16, '指定选修', '2026-10-12 18:05:30', '202300008001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('306300007002', '会计学（Ⅰ）', 3.0, 48, '选修', '2026-10-12 18:34:00', '306300007002');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('306300007010', '经济学原理', 2.0, 32, '必修', '2026-10-12 18:05:20', '306300007010');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3063000184', '物流与供应链管理', 2.0, 32, '选修', '2026-10-12 19:07:33', '3063000184');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3063009358', '信息计量学', 2.0, 32, '选修', '2026-10-12 19:07:33', '3063009358');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3063009366', '企业资源计划', 2.0, 32, '必修', '2026-10-12 18:06:08', '3063009366');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3063009445', '领导力开发', 2.0, 32, '选修', '2026-10-12 18:34:00', '3063009445');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3063009460', '公共组织管理', 1.0, 16, '选修', '2026-10-12 18:34:00', '3063009460');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3063009915', '信息系统开发与维护实践', 1.0, 16, '实践必修', '2026-10-12 18:06:08', '3063009915');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('310300001018', '微积分B（1）', 4.0, 64, '必修', '2026-10-12 18:05:20', '310300001018');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('310300001022', '概率论与数理统计B', 3.0, 48, '必修', '2026-10-12 18:05:39', '310300001022');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('310300001024', '线性代数A', 3.0, 48, '必修', '2026-10-12 18:05:39', '310300001024');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('310300001033', '微积分B（2）', 4.0, 64, '必修', '2026-10-12 18:05:30', '310300001033');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3103000143', '运筹学B', 2.0, 32, '必修', '2026-10-12 18:06:18', '3103000143');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3103009058', '数学建模B', 2.0, 32, '选修', '2026-10-12 18:06:08', '3103009058');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3113009824', '写作与沟通', 1.0, 16, '指定选修', '2026-10-12 18:05:30', '3113009824');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('314300001006', '思想道德与法治', 3.0, 48, '必修', '2026-10-12 18:05:20', '314300001006');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('314300001007', '马克思主义基本原理', 3.0, 48, '必修', '2026-10-12 18:05:39', '314300001007');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('314300001008', '毛泽东思想和中国特色社会主义理论体系概论', 3.0, 48, '必修', '2026-10-12 18:05:48', '314300001008');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('314300001009', '习近平新时代中国特色社会主义思想概论', 3.0, 48, '必修', '2026-10-12 18:05:48', '314300001009');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3143009003', '中国近现代史纲要', 3.0, 48, '必修', '2026-10-12 18:05:30', '3143009003');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3143009104', '形势与政策（一）', 1.0, 16, '必修', '2026-10-12 18:05:30', '3143009104');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3143009105', '形势与政策（二）', 1.0, 16, '必修', '2026-10-12 19:07:33', '3143009105');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007022', '管理学原理B', 2.0, 32, '必修', '2026-10-12 18:05:20', '315300007022');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007063', '管理科学与工程导论', 1.0, 16, '选修', '2026-10-12 18:05:39', '315300007063');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007090', '电子商务概论', 2.0, 32, '必修', '2026-10-12 18:06:18', '315300007090');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007091', 'Web设计与开发', 2.0, 32, '必修', '2026-10-12 18:05:48', '315300007091');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007092', '信息系统分析与设计', 2.0, 32, '必修', '2026-10-12 18:05:57', '315300007092');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007094', 'IT项目管理', 1.0, 16, '必修', '2026-10-12 18:06:18', '315300007094');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007100', '数据分析方法与应用', 1.0, 16, '选修', '2026-10-12 18:05:48', '315300007100');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007101', '信息管理与信息系统学科前沿', 1.0, 16, '指定选修', '2026-10-12 19:07:33', '315300007101');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007102', '信息经济学A', 2.0, 32, '选修', '2026-10-12 18:05:39', '315300007102');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007122', '机器学习', 2.0, 32, '选修', '2026-10-12 19:07:33', '315300007122');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300007136', '社会统计与R语言A', 2.0, 32, '选修', '2026-10-12 18:34:00', '315300007136');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300008010', '网站设计与开发实践', 1.0, 16, '实践必修', '2026-10-12 18:05:57', '315300008010');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300009011', '数据库理论与技术实验', 1.0, 30, '实践必修', '2026-10-12 18:05:57', '315300009011');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300009012', '企业资源计划实验', 1.0, 30, '实践必修', '2026-10-12 18:06:08', '315300009012');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300009013', '信息系统分析与设计实验', 1.0, 30, '实践必修', '2026-10-12 18:05:57', '315300009013');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300009014', 'IT项目管理实验', 1.0, 30, '实践必修', '2026-10-12 18:06:18', '315300009014');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('315300009016', '数据分析方法与应用实验', 1.0, 30, '选修', '2026-10-12 18:05:48', '315300009016');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3153009227', '组织行为学B', 2.0, 32, '选修', '2026-10-12 18:05:48', '3153009227');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3153009238', '经济社会系统仿真', 2.0, 32, '指定选修', '2026-10-12 19:07:33', '3153009238');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3153009247', '数据库理论与技术', 2.0, 32, '必修', '2026-10-12 18:05:57', '3153009247');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3153009258', '信息组织与检索', 2.0, 32, '必修', '2026-10-12 18:05:39', '3153009258');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3153009306', '信息资源管理', 2.0, 32, '必修', '2026-10-12 18:05:57', '3153009306');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('317300007004', '计算机网络B', 3.0, 60, '必修', '2026-10-12 18:06:08', '317300007004');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('317300007010', '数据结构B', 3.0, 60, '必修', '2026-10-12 18:06:08', '317300007010');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('317300007024', 'JAVA语言程序设计', 2.0, 44, '必修', '2026-10-12 18:06:08', '317300007024');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('3173009118', 'C语言程序设计', 2.0, 40, '必修', '2026-10-12 18:05:48', '3173009118');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('9093009774', '大学生创新创业基础', 1.0, 16, '指定选修', '2026-10-12 18:05:30', '9093009774');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('9093009903', '社会实践', 1.0, 16, '实践必修', '2026-10-12 18:05:57', '9093009903');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('9093009904', '军事理论', 2.0, 32, '必修', '2026-10-12 18:05:20', '9093009904');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('9093009905', '军事技能', 2.0, 32, '实践必修', '2026-10-12 18:05:20', '9093009905');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('AE101', '中国工笔绘画技法', 2.0, 32, '选修', '2026-10-12 19:07:33', 'AE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('CPP01', 'C++语言程序设计', 2.0, 40, '必修', '2026-10-12 18:34:00', '3173009118');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('DB001', '数据库应用实践', 1.0, 48, '实践必修', '2026-10-12 16:13:13', '315300008009');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('EN006', '大学英语六级辅导', 2.0, 32, '公共基础课', '2026-10-12 16:13:13', 'FL003');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('EN01A', '大学英语综合（高级）', 2.0, 32, '必修', '2026-10-12 18:34:00', 'FL001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('EN01B', '大学英语综合（中级）', 2.0, 32, '必修', '2026-10-13 09:22:30', 'FL001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('EN02A', '大学英语视听说（高级）', 2.0, 32, '必修', '2026-10-12 18:34:00', 'FL002');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('EN02B', '大学英语视听说（中级）', 2.0, 32, '必修', '2026-10-13 09:22:30', 'FL002');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('EN03A', '跨文化交际', 2.0, 32, '必修', '2026-10-12 18:34:00', 'FL003');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('EN04A', '学术英语（人文社科类）', 2.0, 32, '必修', '2026-10-12 18:34:00', 'FL004');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('ERP01', '基于ERP沙盘的经营模拟实验', 1.0, 30, '选修', '2026-10-12 18:34:00', '315300009018');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('FL001', '大学英语（一）', 2.0, 32, '必修', '2026-10-12 18:05:20', 'FL001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('FL002', '大学英语（二）', 2.0, 32, '必修', '2026-10-12 18:05:30', 'FL002');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('FL003', '大学英语（三）', 2.0, 32, '必修', '2026-10-12 18:05:39', 'FL003');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('FL004', '大学英语（四）', 2.0, 32, '必修', '2026-10-12 18:05:57', 'FL004');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE101', '营养、膳食与健康', 1.0, 16, '选修', '2026-10-12 18:34:00', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE102', '视听语言（MOOC）', 1.0, 16, '选修', '2026-10-12 18:34:00', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE103', '艾滋病、性与健康（智慧树MOOC）', 1.0, 16, '选修', '2026-10-12 18:34:00', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE104', '人像摄影（MOOC）', 1.0, 16, '选修', '2026-10-12 18:34:00', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE105', '常见动物中毒毒物分析与检验技术', 1.0, 16, '选修', '2026-10-12 19:07:33', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE106', '食品与感官科学', 1.0, 16, '选修', '2026-10-13 09:22:30', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE107', 'Excel电子表格与数据处理（MOOC）', 1.5, 24, '选修', '2026-10-13 09:22:30', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE108', '野生动物资源保护与利用', 2.0, 32, '选修', '2026-10-13 09:22:30', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('GE109', '中国少数民族神话赏析（MOOC）', 1.0, 16, '选修', '2026-10-13 09:22:30', 'GE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('IMP0C8CFBB67A', '高等数学A(上)', 5.0, 80, '必修', '2026-10-13 14:27:58', 'IMP3071E9B57A');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('IMP14789A7BFC', '大学物理', 4.0, 64, '必修', '2026-10-13 14:27:58', 'IMPDE64BD71E1');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('IMP4D42F2865F', '程序设计基础', 5.0, 80, '必修', '2026-10-13 14:27:58', 'IMPE1C32D096E');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('IMP5B8F92FC92', '高等数学（一）', 3.0, 48, '必修', '2026-10-13 14:27:58', 'IMP847E50730B');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('INTL01', '全球胜任力', 2.0, 32, '必修', '2026-10-13 09:22:30', 'MAJOR_INTL');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('IT02A', 'IT项目管理', 2.0, 32, '必修', '2026-10-12 19:07:33', '315300007094');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('MG001', '管理信息系统', 2.0, 48, '必修', '2026-10-12 16:13:13', '3063009313');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('MG101', '管理学', 3.0, 48, '必修', '2026-10-13 09:22:30', '315300007022');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE001', '体育（一）', 1.0, 32, '必修', '2026-10-12 18:05:20', 'PE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE002', '体育（二）', 1.0, 32, '必修', '2026-10-12 18:05:30', 'PE002');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE003', '体育（三）', 1.0, 32, '必修', '2026-10-12 18:05:48', 'PE003');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE004', '体育（四）', 1.0, 32, '必修', '2026-10-12 18:06:08', 'PE004');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE01B', '球类B', 1.0, 32, '必修', '2026-10-12 18:34:00', 'PE001');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE02A', '游泳A', 1.0, 32, '必修', '2026-10-12 18:34:00', 'PE002');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE03C', '太极柔力球C', 1.0, 32, '必修', '2026-10-12 18:34:00', 'PE003');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE03D', '乒乓球C', 1.0, 32, '必修', '2026-10-13 09:22:30', 'PE003');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PE04C', '健美操C', 1.0, 32, '必修', '2026-10-12 18:34:00', 'PE004');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('PY001', 'Python程序设计', 2.0, 48, '必修', '2026-10-12 16:13:13', '3173009119');
INSERT IGNORE INTO courses (course_id, course_name, credit, hours, nature, created_at, plan_code) VALUES ('IMP12D6F5DEB1', '影视鉴赏', 2.0, 32, '选修', '2026-10-13 14:27:58', 'AE001');

--
-- Data for Name: course_arrangements; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (168, 'IMP0C8CFBB67A', '信管2401', '2025-2026-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (169, 'IMP12D6F5DEB1', '信管2401', '2025-2026-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (170, 'PE004', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (171, 'IMP5B8F92FC92', '信管2401', '2025-2026-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (172, 'IMP14789A7BFC', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (173, 'IMP4D42F2865F', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (103, 'ERP01', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (1, 'DB001', '信管2401', '2026-2027-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (2, 'PY001', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (3, 'MG001', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (4, 'EN006', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (5, '314300001006', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (6, 'FL001', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (7, '310300001018', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (8, '315300007022', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (9, '306300007010', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (10, 'PE001', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (11, '9093009904', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (12, '9093009905', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (13, '202300008001', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (14, '3113009824', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (15, '9093009774', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (16, '3143009003', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (17, 'FL002', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (18, '310300001033', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (19, '3143009104', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (20, 'PE002', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (21, '202300006005', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (22, '315300007063', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (23, '315300007102', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (24, '314300001007', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (25, 'FL003', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (26, '310300001022', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (27, '3153009258', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (28, '310300001024', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (29, '3173009118', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (30, '315300007091', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (31, 'PE003', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (32, '315300007100', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (33, '315300009016', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (34, '3153009227', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (35, '314300001008', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (36, '314300001009', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (37, 'FL004', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (38, '3153009247', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (39, '315300009011', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (40, '3153009306', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (41, '315300007092', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (104, 'PE03C', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (105, '310300001022', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (42, '315300009013', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (43, '315300008010', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (44, '9093009903', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (45, '317300007024', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (46, '317300007010', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (47, 'PE004', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (48, '3103009058', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (49, '3063009366', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (50, '315300009012', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (51, '317300007004', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (52, '3063009915', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (53, '315300007094', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (54, '315300009014', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (55, '315300007090', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (56, '3103000143', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (57, '315300007022', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (58, '306300007010', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (59, 'PY001', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (60, '3143009003', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (61, '315300007102', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (62, '202300006005', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (63, '202300008001', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (64, 'EN02A', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (65, '3113009824', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (66, '9093009905', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (67, '9093009904', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (68, '9093009774', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (69, 'EN01A', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (70, '310300001018', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (71, '314300001006', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (72, 'PE01B', '信管2402', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (73, '3143009104', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (74, '310300001033', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (75, 'PE02A', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (76, '315300007063', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (77, 'GE101', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (78, 'GE102', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (79, '3063009445', '信管2402', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (80, 'CPP01', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (81, '315300007136', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (82, '315300008010', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (83, '310300001022', '信管2402（重修）', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (84, 'GE103', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (85, 'EN03A', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (86, '314300001007', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (87, '317300007024', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (88, '314300001009', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (89, 'GE104', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (90, '315300007092', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (91, '315300009013', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (92, '3153009306', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (93, 'PE04C', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (94, '3063009460', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (95, 'EN04A', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (96, '3153009247', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (97, '315300009011', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (98, '317300007010', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (99, '314300001008', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (100, '315300007091', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (101, '306300007002', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (102, '3153009258', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (106, 'MG001', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (107, '310300001024', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (108, '315300007090', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (109, '3103000143', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (110, '3063000184', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (111, 'AE101', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (112, '3143009105', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (113, '310300001033', '信管2402（重修）', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (114, 'DB001', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (115, '3063009358', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (116, '315300009014', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (117, 'IT02A', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (118, 'GE105', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (119, '3153009238', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (120, '317300007004', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (121, '3063009915', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (122, '315300009012', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (123, '3063009366', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (124, '315300007101', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (125, '315300007122', '信管2402', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (126, '315300007122', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (127, '3153009238', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (128, 'AE101', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (129, 'GE105', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (130, 'IT02A', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (131, '3153009227', '信管2402', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (132, '3103009058', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (133, '9093009903', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (134, 'INTL01', '信管2402', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (135, '310300001033', '信管2402（重修）', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (136, 'EN01B', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (137, 'GE106', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (138, 'MG101', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (139, 'PE01B', '信管2401', '2024-2025-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (140, '202300008001', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (141, '3063009445', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (142, '3113009824', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (143, 'EN02B', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (144, 'GE107', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (145, 'GE108', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (146, 'PE02A', '信管2401', '2024-2025-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (147, '306300007002', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (148, 'CPP01', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (149, 'GE109', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (150, 'INTL01', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (151, 'PE03D', '信管2401', '2025-2026-1', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (152, '3063009460', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (153, '315300007136', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (154, 'EN04A', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (155, 'PE04C', '信管2401', '2025-2026-2', 1);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (156, '3063000184', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (157, '3063009358', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (158, '3143009105', '信管2401', '2026-2027-1', 0);
INSERT IGNORE INTO course_arrangements (arrange_id, course_id, class_name, semester, is_archived) VALUES (159, '315300007101', '信管2401', '2026-2027-1', 0);

--
-- Data for Name: students; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220207', '高梓竣', '', '信管2401', '信息管理与信息系统', 2024, '13800000013', '在读', '2026-10-13 09:22:40');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220205', '陈维贺', '', '信管2401', '信息管理与信息系统', 2024, '13800000011', '在读', '2026-10-13 09:22:40');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220106', '谌开', '', '信管2401', '信息管理与信息系统', 2024, '13800001006', '在读', '2026-10-12 16:13:13');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220102', '刘辉', '', '信管2401', '信息管理与信息系统', 2024, '13800001002', '在读', '2026-10-12 16:13:13');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220103', '庞昌好', '', '信管2401', '信息管理与信息系统', 2024, '13800001003', '在读', '2026-10-12 16:13:13');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220127', '吴胜男', '', '信管2401', '信息管理与信息系统', 2024, '13800000016', '在读', '2026-10-13 09:22:40');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2023305240203', '黄毅', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220426', '邓何洁', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024301220428', '吴水鑫', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220101', '刘浩然', '', '信管2402', '信息管理与信息系统', 2024, '13800001001', '在读', '2026-10-12 16:13:13');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220121', '陈硕', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220128', '柯霖', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220129', '汪璐楠', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220130', '刘涵', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220201', '安琰', '', '信管2402', '信息管理与信息系统', 2024, '13800000007', '在读', '2026-10-12 18:33:26');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220202', '李俊志', '', '信管2402', '信息管理与信息系统', 2024, '13800000008', '在读', '2026-10-13 09:22:40');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220203', '李昊翔', '', '信管2402', '信息管理与信息系统', 2024, '13800000009', '在读', '2026-10-13 09:22:40');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220204', '朱正雷', '', '信管2402', '信息管理与信息系统', 2024, '13800000010', '在读', '2026-10-13 09:22:40');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220208', '倪宗晨', '', '信管2402', '信息管理与信息系统', 2024, '13800000014', '在读', '2026-10-13 09:22:40');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220213', '舒帝', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220217', '冯恬恬', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220326', '高佳颖', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220218', '崔艺玮', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220431', '郝钰婷', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220225', '景攀西', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220125', '何思彤', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220227', '屈羽希', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220124', '肖言', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220123', '郑丽淇', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220119', '王紫昀', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220228', '谭湘庆', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220212', '尹鑫一', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220327', '徐艳萍', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220318', '成文慧', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220126', '李小蕾', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220117', '范羲蓓', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220416', '向傲', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220120', '柳萤', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220222', '朱紫萤', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220319', '郑芯雨', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220211', '宋展翼', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220219', '王小涵', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220116', '阮宇翔', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220109', '罗俊友', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315210428', '范雪妍', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2023305230117', '覃凯楠', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220214', '张皓程', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220110', '高兴', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220420', '张语桐', '', '信管2401', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('0000000000000', '李华', '', '演示数据', '信息管理与信息系统', 2024, NULL, '演示', '2026-10-14 13:32:37');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220223', '熊芯婷', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220224', '钱娇', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220229', '柏婉婷', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220231', '牛曼妤', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220309', '王润泽', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220312', '王小旭', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220313', '舒泓博', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220317', '罗蕊', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220320', '刘馨悦', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220322', '邵巧玲', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220411', '王嘉乐', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220415', '李德远', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220417', '张子涵', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220418', '钟鸣扬', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220419', '黄蕊', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220422', '刘斯卉', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220423', '段鲁涵', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220425', '文钰莹', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220428', '罗诗琪', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220429', '刘钰鑫', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220430', '林欣妍', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');
INSERT IGNORE INTO students (student_id, name, gender, class_name, major_name, enroll_year, phone, status, created_at) VALUES ('2024315220432', '石晓茹', '', '信管2402', '信息管理与信息系统', 2024, NULL, '在读', '2026-10-14 10:16:53');

--
-- Data for Name: scores; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (343, '0000000000000', 77, 97.0, 87.0, 91.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (344, '0000000000000', 78, 96.0, 86.0, 90.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (345, '0000000000000', 79, 85.0, 95.0, 91.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (346, '0000000000000', 86, 83.0, 88.0, 86.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (347, '0000000000000', 100, 81.0, 91.0, 87.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (348, '0000000000000', 101, 95.0, 85.0, 89.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (349, '0000000000000', 105, 76.0, 86.0, 82.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (350, '0000000000000', 107, 84.0, 94.0, 90.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (353, '0000000000000', 80, 100.0, 90.0, 94.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (354, '0000000000000', 81, 76.0, 86.0, 82.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (355, '0000000000000', 82, 88.0, 93.0, 91.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (356, '0000000000000', 84, 90.0, 100.0, 96.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (357, '0000000000000', 85, 89.0, 84.0, 86.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (358, '0000000000000', 87, 97.0, 87.0, 91.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (359, '0000000000000', 88, 83.0, 93.0, 89.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (360, '0000000000000', 89, 91.0, 96.0, 94.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (361, '0000000000000', 90, 92.0, 82.0, 86.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (362, '0000000000000', 91, 85.0, 90.0, 88.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (363, '0000000000000', 92, 90.0, 90.0, 90.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (364, '0000000000000', 93, 91.0, 81.0, 85.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (365, '0000000000000', 94, 91.0, 86.0, 88.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (366, '0000000000000', 95, 96.0, 91.0, 93.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (367, '0000000000000', 96, 85.0, 90.0, 88.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (368, '0000000000000', 97, 81.0, 91.0, 87.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (369, '0000000000000', 98, 88.0, 98.0, 94.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (370, '0000000000000', 99, 88.0, 93.0, 91.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (371, '0000000000000', 102, 85.0, 95.0, 91.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (372, '0000000000000', 103, 93.0, 93.0, 93.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (373, '0000000000000', 104, 81.0, 91.0, 87.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (374, '0000000000000', 106, 91.0, 96.0, 94.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (375, '0000000000000', 131, 79.0, 89.0, 85.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (376, '0000000000000', 132, 82.0, 92.0, 88.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (377, '0000000000000', 133, 93.0, 98.0, 96.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (378, '0000000000000', 134, 83.0, 88.0, 86.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (934, '0000000000000', 124, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (935, '0000000000000', 123, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (936, '0000000000000', 122, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (937, '0000000000000', 121, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (938, '0000000000000', 120, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (939, '0000000000000', 119, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (940, '0000000000000', 118, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (323, '0000000000000', 57, 85.0, 95.0, 91.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (324, '0000000000000', 58, 95.0, 85.0, 89.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (325, '0000000000000', 59, 95.0, 90.0, 92.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (326, '0000000000000', 60, 90.0, 90.0, 90.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (327, '0000000000000', 61, 82.0, 92.0, 88.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (328, '0000000000000', 62, 88.0, 83.0, 85.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (329, '0000000000000', 63, 83.0, 88.0, 86.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (330, '0000000000000', 64, 86.0, 91.0, 89.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (331, '0000000000000', 65, 83.0, 93.0, 89.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (332, '0000000000000', 66, 90.0, 95.0, 93.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (333, '0000000000000', 67, 83.0, 93.0, 89.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (334, '0000000000000', 68, 91.0, 86.0, 88.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (335, '0000000000000', 69, 84.0, 89.0, 87.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (336, '0000000000000', 70, 92.0, 82.0, 86.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (337, '0000000000000', 71, 97.0, 87.0, 91.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (338, '0000000000000', 72, 89.0, 89.0, 89.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (339, '0000000000000', 73, 86.0, 96.0, 92.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (340, '0000000000000', 74, 90.0, 85.0, 87.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (341, '0000000000000', 75, 93.0, 83.0, 87.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (342, '0000000000000', 76, 96.0, 86.0, 90.0, NULL, '正常', 1, '2026-10-13 09:23:15');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (933, '0000000000000', 125, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (941, '0000000000000', 117, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (942, '0000000000000', 116, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (943, '0000000000000', 115, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (944, '0000000000000', 114, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (945, '0000000000000', 112, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (946, '0000000000000', 111, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (947, '0000000000000', 110, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (948, '0000000000000', 109, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');
INSERT IGNORE INTO scores (score_id, student_id, arrange_id, usual_score, exam_score, total_score, gp, status, is_archived, updated_at) VALUES (949, '0000000000000', 108, NULL, NULL, NULL, NULL, '在修', 0, '2026-10-13 11:19:22');

--
-- Name: course_arrangements_arrange_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

--
-- Name: scores_score_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

--
-- Name: course_arrangements_arrange_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

--
-- Name: scores_score_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

-- ============================================================
-- 培养方案内置数据（26 类目 / 102 门课）：成绩导入的「学分归属」校验依赖本表
-- 数据与前端 assets/plan-2023.json 完全一致
-- ============================================================
INSERT IGNORE INTO plan_categories (code, name, parent_code, required_credits, note, sort) VALUES ('POL', '思想政治理论课程', NULL, 16.0, '含形势与政策（一）（二）', 1), ('PUB', '公共基础课程', NULL, 26.0, NULL, 2), ('PEAL', '体美劳育课程', NULL, 6.0, NULL, 3), ('GE', '通识课程', NULL, 9.0, '指定选修4门共4学分+任选5学分（大学生心理素质拓展为默认必选）', 4), ('MAJOR', '学科专业类课程', NULL, 64.0, NULL, 5), ('PRAC', '实践教学环节', NULL, 30.0, '必修28学分+指定选修2学分', 6), ('PUB_FL', '外语类课程', 'PUB', 8.0, '1-4学期修读完成，每学期2学分', 21), ('PUB_MATH', '数学类课程', 'PUB', 14.0, NULL, 22), ('PUB_IT', '信息科技类课程', 'PUB', 2.0, NULL, 23), ('PUB_MIL', '军事理论', 'PUB', 2.0, NULL, 24), ('PEAL_PE', '体育类课程', 'PEAL', 4.0, '一、二年级每学期修1学分', 31), ('PEAL_AE', '美育类课程', 'PEAL', 2.0, '自主选择学期，毕业前修完', 32), ('PEAL_LAB', '劳育类课程', 'PEAL', NULL, '不单独计算学分，劳动学时≥32', 33), ('MAJOR_PLAT', '学科专业平台课程', 'MAJOR', 23.0, NULL, 51), ('MAJOR_CORE', '专业核心课程', 'MAJOR', 12.0, NULL, 52), ('MAJOR_ELEC', '开放性专业选修课程', 'MAJOR', 27.0, '四子类任选；交叉类课程≥4学分', 53), ('MAJOR_INTL', '国际课程（项目）', 'MAJOR', 2.0, '可通过国际课程、暑期课程、游学实践等认定', 54), ('PRAC_PUB', '公共实践', 'PRAC', 7.0, NULL, 61), ('PRAC_PRO', '专业实践', 'PRAC', 16.0, '集中实践：学术道德规范教育、数据库应用实践、网站设计与开发实践、信息系统开发与维护实践、IT项目管理沙盘模拟实践、网络商务策划与创新实践、教学实习、毕业实习、毕业论文（设计）', 62), ('ELEC_IT', '① 信息系统与信息技术类', 'MAJOR_ELEC', NULL, '方向一', 531), ('ELEC_MGMT', '② 信息管理与应用类', 'MAJOR_ELEC', NULL, '方向二', 532), ('ELEC_BD', '③ 大数据分析方法与工具类', 'MAJOR_ELEC', NULL, '方向三', 533), ('ELEC_CROSS', '④ 管理与交叉融合类', 'MAJOR_ELEC', NULL, '方向四', 534), ('PRAC_INNO', '创新创业实践', 'PRAC_PUB', NULL, '方案固定 1 学分的「创新创业实践」：实际修的课名因人而异（各类创新项目、竞赛类课程），导入时课程类别填「创新创业实践」即自动归到这里', 611), ('PRAC_OPT', '指定选修', 'PRAC_PRO', 2.0, '农业企业信息化实施与案例实践、经济社会系统仿真实践（2 项 2 学分）', 621), ('PRAC_LAB', '配套实验', 'PRAC_PRO', 5.0, '专业核心课配套实验（5 项 5 学分）', 622);

INSERT IGNORE INTO plan_courses (code, name, credits, sem_from, sem_to, category_code, nature, is_generic, note) VALUES ('315300007100', '数据分析方法与应用', 1.0, 3, 3, 'ELEC_BD', '选修', 0, NULL), ('315300009016', '数据分析方法与应用实验', 1.0, 3, 3, 'ELEC_BD', '选修', 0, NULL), ('3103009058', '数学建模B', 2.0, 4, 4, 'ELEC_BD', '选修', 0, NULL), ('315300007136', '社会统计与R语言A', 2.0, 4, 4, 'ELEC_BD', '选修', 0, NULL), ('315300007139', '三维空间信息采集处理及建模(校企合作)', 1.0, 5, 5, 'ELEC_BD', '选修', 0, NULL), ('315300009020', '三维空间信息采集处理及建模实验(校企合作)', 1.0, 5, 5, 'ELEC_BD', '选修', 0, NULL), ('315300007108', '大数据分析与应用', 2.0, 7, 7, 'ELEC_BD', '选修', 0, NULL), ('3063009190', '商务谈判', 2.0, 2, 2, 'ELEC_CROSS', '选修', 0, NULL), ('3063009445', '领导力开发', 2.0, 2, 2, 'ELEC_CROSS', '选修', 0, NULL), ('315300007036', '城市与房地产经济学', 2.0, 2, 2, 'ELEC_CROSS', '选修', 0, NULL), ('306300007002', '会计学（Ι）', 3.0, 3, 3, 'ELEC_CROSS', '选修', 0, NULL), ('3063009460', '公共组织管理', 1.0, 3, 4, 'ELEC_CROSS', '选修', 0, NULL), ('3153009227', '组织行为学B', 2.0, 3, 3, 'ELEC_CROSS', '选修', 0, NULL), ('3063000184', '物流与供应链管理', 2.0, 5, 5, 'ELEC_CROSS', '选修', 0, NULL), ('3063009116', '财务管理B', 3.0, 6, 6, 'ELEC_CROSS', '选修', 0, NULL), ('315300007098', '数字图像处理技术', 2.0, 5, 5, 'ELEC_IT', '选修', 0, NULL), ('315300007122', '机器学习', 2.0, 5, 5, 'ELEC_IT', '选修', 0, NULL), ('3153009238', '经济社会系统仿真', 2.0, 5, 5, 'ELEC_IT', '指定选修', 0, NULL), ('3063009328', '数据仓库与数据挖掘', 2.0, 6, 6, 'ELEC_IT', '选修', 0, NULL), ('315300007010', '空间信息系统', 2.0, 6, 6, 'ELEC_IT', '选修', 0, NULL), ('315300008012', '软件测试技术与案例实践(校企合作)', 1.0, 6, 6, 'ELEC_IT', '选修', 0, NULL), ('317300007008', '操作系统B', 3.0, 6, 6, 'ELEC_IT', '选修', 0, NULL), ('315300007097', '物联网技术', 2.0, 7, 7, 'ELEC_IT', '选修', 0, NULL), ('315300007102', '信息经济学A', 2.0, 2, 2, 'ELEC_MGMT', '选修', 0, NULL), ('3063009358', '信息计量学', 2.0, 5, 5, 'ELEC_MGMT', '选修', 0, NULL), ('315300007101', '信息管理与信息系统学科前沿', 1.0, 5, 5, 'ELEC_MGMT', '指定选修', 0, NULL), ('315300007104', '信息服务与用户', 2.0, 6, 6, 'ELEC_MGMT', '选修', 0, NULL), ('315300007106', '企业运营管理模拟', 1.0, 6, 6, 'ELEC_MGMT', '选修', 0, NULL), ('315300007107', '客户关系管理', 2.0, 6, 6, 'ELEC_MGMT', '选修', 0, NULL), ('315300007109', '数字工程原理和方法', 1.0, 6, 6, 'ELEC_MGMT', '选修', 0, NULL), ('315300009018', '企业运营管理模拟实验', 1.0, 6, 6, 'ELEC_MGMT', '选修', 0, NULL), ('315300009019', '数字工程原理和方法实验', 1.0, 6, 6, 'ELEC_MGMT', '选修', 0, NULL), ('3153009261', '知识工程与商务智能', 2.0, 6, 6, 'ELEC_MGMT', '选修', 0, NULL), ('3113009824', '写作与沟通', 1.0, 1, 1, 'GE', '指定选修', 0, NULL), ('9093009774', '大学生创新创业基础', 1.0, 1, 1, 'GE', '指定选修', 0, NULL), ('GE001', '通识选修课程（任选）', 5.0, 1, 8, 'GE', '选修', 1, NULL), ('202300006005', '大学生心理发展与指导', 1.0, 2, 2, 'GE', '指定选修', 0, NULL), ('3063009313', '管理信息系统A', 2.0, 3, 3, 'MAJOR_CORE', '必修', 0, NULL), ('315300007092', '信息系统分析与设计', 2.0, 4, 4, 'MAJOR_CORE', '必修', 0, NULL), ('3153009247', '数据库理论与技术', 2.0, 4, 4, 'MAJOR_CORE', '必修', 0, NULL), ('3153009306', '信息资源管理', 2.0, 4, 4, 'MAJOR_CORE', '必修', 0, NULL), ('3063009366', '企业资源计划', 2.0, 5, 5, 'MAJOR_CORE', '必修', 0, NULL), ('315300007094', 'IT项目管理', 1.0, 5, 5, 'MAJOR_CORE', '必修', 0, NULL), ('315300007095', '信息安全与保密', 1.0, 6, 6, 'MAJOR_CORE', '必修', 0, NULL), ('MAJOR_INTL', '国际课程（项目）（任选）', 2.0, 1, 8, 'MAJOR_INTL', '选修', 1, NULL), ('315300003008', 'Agricultural Knowledge and Information Systems', 2.0, 6, 6, 'MAJOR_INTL', '选修', 0, NULL), ('306300007010', '经济学原理', 2.0, 1, 1, 'MAJOR_PLAT', '必修', 0, NULL), ('315300007022', '管理学原理B', 2.0, 1, 1, 'MAJOR_PLAT', '必修', 0, NULL), ('315300007063', '管理科学与工程导论', 1.0, 2, 2, 'MAJOR_PLAT', '必修', 0, NULL), ('315300007091', 'Web设计与开发', 2.0, 3, 3, 'MAJOR_PLAT', '必修', 0, NULL), ('3153009258', '信息组织与检索', 2.0, 3, 3, 'MAJOR_PLAT', '必修', 0, NULL), ('3173009118', 'C语言程序设计', 2.0, 3, 3, 'MAJOR_PLAT', '必修', 0, NULL), ('317300007010', '数据结构B', 3.0, 4, 4, 'MAJOR_PLAT', '必修', 0, NULL), ('317300007024', 'JAVA语言程序设计', 2.0, 4, 4, 'MAJOR_PLAT', '必修', 0, NULL), ('3103000143', '运筹学B', 2.0, 5, 5, 'MAJOR_PLAT', '必修', 0, NULL), ('315300007090', '电子商务概论', 2.0, 5, 5, 'MAJOR_PLAT', '必修', 0, NULL), ('317300007004', '计算机网络B', 3.0, 5, 5, 'MAJOR_PLAT', '必修', 0, NULL), ('AE001', '美育类课程（任选）', 2.0, 1, 8, 'PEAL_AE', '选修', 1, NULL), ('315300008021', '数字乡村劳动实习', 2.0, 6, 6, 'PEAL_LAB', '必修', 0, NULL), ('PE001', '体育（一）', 1.0, 1, 1, 'PEAL_PE', '必修', 1, NULL), ('PE002', '体育（二）', 1.0, 2, 2, 'PEAL_PE', '必修', 1, NULL), ('PE003', '体育（三）', 1.0, 3, 3, 'PEAL_PE', '必修', 1, NULL), ('PE004', '体育（四）', 1.0, 4, 4, 'PEAL_PE', '必修', 1, NULL), ('314300001006', '思想道德与法治', 3.0, 1, 1, 'POL', '必修', 0, NULL), ('3143009104', '形势与政策（一）', 1.0, 1, 2, 'POL', '必修', 0, NULL), ('3143009003', '中国近现代史纲要', 3.0, 2, 2, 'POL', '必修', 0, NULL), ('314300001007', '马克思主义基本原理', 3.0, 3, 3, 'POL', '必修', 0, NULL), ('314300001008', '毛泽东思想和中国特色社会主义理论体系概论', 3.0, 4, 4, 'POL', '必修', 0, NULL), ('314300001009', '习近平新时代中国特色社会主义思想概论', 3.0, 4, 4, 'POL', '必修', 0, NULL), ('315300009011', '数据库理论与技术实验', 1.0, 4, 4, 'PRAC_LAB', '必修', 0, NULL), ('315300009013', '信息系统分析与设计实验', 1.0, 4, 4, 'PRAC_LAB', '必修', 0, NULL), ('315300009012', '企业资源计划实验', 1.0, 5, 5, 'PRAC_LAB', '必修', 0, NULL), ('315300009014', 'IT项目管理实验', 1.0, 5, 5, 'PRAC_LAB', '必修', 0, NULL), ('315300009015', '信息安全与保密实验', 1.0, 6, 6, 'PRAC_LAB', '必修', 0, NULL), ('315300008011', '农业企业信息化实施与案例实践(校企合作)', 1.0, 6, 6, 'PRAC_OPT', '指定选修', 0, NULL), ('315300008013', '经济社会系统仿真实践', 1.0, 6, 6, 'PRAC_OPT', '指定选修', 0, NULL), ('315300008010', '网站设计与开发实践', 1.0, 4, 4, 'PRAC_PRO', '必修', 0, NULL), ('3063009915', '信息系统开发与维护实践', 1.0, 5, 5, 'PRAC_PRO', '必修', 0, NULL), ('315300008009', '数据库应用实践', 1.0, 5, 5, 'PRAC_PRO', '必修', 0, NULL), ('315300008014', '网络商务策划与创新实践', 1.0, 6, 6, 'PRAC_PRO', '必修', 0, NULL), ('315300008026', 'IT项目管理沙盘模拟实践', 1.0, 6, 6, 'PRAC_PRO', '必修', 0, NULL), ('3153009930', '教学实习', 2.0, 6, 6, 'PRAC_PRO', '必修', 0, NULL), ('315300007085', '学术道德规范教育', 1.0, 7, 7, 'PRAC_PRO', '必修', 0, NULL), ('3153009932', '毕业论文（设计）', 6.0, 7, 8, 'PRAC_PRO', '必修', 0, NULL), ('3153009931', '毕业实习', 2.0, 8, 8, 'PRAC_PRO', '必修', 0, NULL), ('110300008002', '美育实践', 1.0, 1, 7, 'PRAC_PUB', '必修', 0, NULL), ('202300008001', '大学生心理素质拓展', 1.0, 1, 1, 'GE', '指定选修', 0, NULL), ('9093009905', '军事技能', 2.0, 1, 1, 'PRAC_PUB', '必修', 0, NULL), ('9093009906', '创新创业实践', 1.0, 1, 7, 'PRAC_INNO', '必修', 0, NULL), ('3143009105', '形势与政策（二）', 1.0, 3, 8, 'PRAC_PUB', '必修', 0, NULL), ('9093009903', '社会实践', 1.0, 3, 4, 'PRAC_PUB', '必修', 0, NULL), ('110300008001', '志愿服务', 1.0, 5, 6, 'PRAC_PUB', '必修', 0, NULL), ('FL001', '大学外语（一）', 2.0, 1, 1, 'PUB_FL', '必修', 1, NULL), ('FL002', '大学外语（二）', 2.0, 2, 2, 'PUB_FL', '必修', 1, NULL), ('FL003', '大学外语（三）', 2.0, 3, 3, 'PUB_FL', '必修', 1, NULL), ('FL004', '大学外语（四）', 2.0, 4, 4, 'PUB_FL', '必修', 1, NULL), ('3173009119', 'Python语言程序设计', 2.0, 2, 2, 'PUB_IT', '必修', 0, NULL), ('310300001018', '微积分B（1）', 4.0, 1, 1, 'PUB_MATH', '必修', 0, NULL), ('310300001033', '微积分B（2）', 4.0, 2, 2, 'PUB_MATH', '必修', 0, NULL), ('310300001022', '概率论与数理统计B', 3.0, 3, 3, 'PUB_MATH', '必修', 0, NULL), ('310300001024', '线性代数A', 3.0, 3, 3, 'PUB_MATH', '必修', 0, NULL), ('9093009904', '军事理论', 2.0, 1, 1, 'PUB_MIL', '必修', 0, NULL);
