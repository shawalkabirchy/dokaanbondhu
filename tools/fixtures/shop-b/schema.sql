-- Test shop B (D122): a shop app on MySQL 8 shaped unlike GearGrid, so every feature is tested on a second kind of
-- host. Other table and column names; integer IDs; car models without a make column, chassis codes in the name and
-- years as text; a part-to-car table that covers only some items (the rest name their cars in the item name or
-- remarks); stock per branch; a price history; its own words for grade, side, unit and customer kind; item groups as
-- categories; Bangla customer names; amounts with paisa written as decimals (read as whole taka, D110).

CREATE TABLE item_groups (
  group_id INT PRIMARY KEY,
  title VARCHAR(80) NOT NULL
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE car_models (
  model_id INT PRIMARY KEY,
  model_name VARCHAR(80) NOT NULL,
  years VARCHAR(20),
  engine VARCHAR(20)
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE items (
  item_id INT PRIMARY KEY,
  item_name VARCHAR(160) NOT NULL,
  group_id INT NOT NULL,
  grade VARCHAR(20),
  side VARCHAR(10),
  uom VARCHAR(10),
  remarks VARCHAR(255),
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (group_id) REFERENCES item_groups (group_id)
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE item_codes (
  code_id INT PRIMARY KEY,
  item_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items (item_id)
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE item_cars (
  item_id INT NOT NULL,
  model_id INT NOT NULL,
  PRIMARY KEY (item_id, model_id),
  FOREIGN KEY (item_id) REFERENCES items (item_id),
  FOREIGN KEY (model_id) REFERENCES car_models (model_id)
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE branches (
  branch_id INT PRIMARY KEY,
  branch_name VARCHAR(40) NOT NULL
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE branch_stock (
  stock_id INT PRIMARY KEY,
  item_id INT NOT NULL,
  branch_id INT NOT NULL,
  qty DECIMAL(10, 2) NOT NULL,
  shelf VARCHAR(20),
  FOREIGN KEY (item_id) REFERENCES items (item_id),
  FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE item_prices (
  price_id INT PRIMARY KEY,
  item_id INT NOT NULL,
  sale_rate DECIMAL(10, 2) NOT NULL,
  workshop_rate DECIMAL(10, 2),
  dealer_rate DECIMAL(10, 2),
  cost_rate DECIMAL(10, 2),
  effective_from DATE NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items (item_id)
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE parties (
  party_id INT PRIMARY KEY,
  party_name VARCHAR(80) NOT NULL,
  party_name_bn VARCHAR(80),
  party_kind VARCHAR(20),
  mobile VARCHAR(20),
  balance DECIMAL(12, 2) NOT NULL DEFAULT 0,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE vendors (
  vendor_id INT PRIMARY KEY,
  vendor_name VARCHAR(80) NOT NULL,
  phone VARCHAR(20)
) DEFAULT CHARSET = utf8mb4;
