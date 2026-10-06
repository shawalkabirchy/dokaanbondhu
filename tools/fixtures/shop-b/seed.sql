-- Test shop B's data (D122). The expected answers of packages/engine/test/shop-b.integration.test.ts come from here.

INSERT INTO item_groups (group_id, title) VALUES
  (1, 'Brake Pad'),
  (2, 'Shock Absorber'),
  (3, 'AC Compressor'),
  (4, 'Engine Oil'),
  (5, 'Power Steering Pump');

-- No make column; chassis codes in the model name; years written as text.
INSERT INTO car_models (model_id, model_name, years, engine) VALUES
  (1, 'Axio NZE141', '2012-2017', '1NZ'),
  (2, 'Fielder', '2012-2017', '1NZ'),
  (3, 'Tucson', '2016-2020', NULL),
  (4, 'Axio', '2006-2011', '1NZ'),
  -- A second chassis of the same years: a part fitting both is still one part.
  (5, 'Axio NZE144', '2012-2017', '1NZ');

INSERT INTO items (item_id, item_name, group_id, grade, side, uom, remarks, is_deleted) VALUES
  -- Only its group says it is a brake pad.
  (1, 'Toyota 04465-12610', 1, 'OEM', 'F', 'set', NULL, 0),
  (2, 'Brake Pad F Copy', 1, 'Copy', 'F', 'set', NULL, 0),
  -- No item_cars rows: the cars are written in the name or the remarks.
  (3, 'Shock Absorber FL Tucson 2016-20', 2, 'Copy', 'FL', 'pcs', NULL, 0),
  (4, 'AC Compressor Axio/Fielder 2012-17', 3, 'Used', NULL, 'pcs', NULL, 0),
  (5, 'Power Steering Pump', 5, 'OEM', NULL, 'pcs', 'Fits Axio 2012-2017', 0),
  (6, 'Engine Oil 5W-30 4L', 4, 'OEM', NULL, 'ltr', NULL, 0),
  -- "R" may be rear or right: the owner says which in setup.
  (7, 'Brake Pad R Copy', 1, 'Copy', 'R', 'set', NULL, 0),
  (8, 'Brake Pad F old stock', 1, 'Copy', 'F', 'set', NULL, 1);

INSERT INTO item_codes (code_id, item_id, code) VALUES
  (1, 1, '04465-12610'),
  (2, 2, 'BP-141F'),
  (3, 7, 'BP-141R');

INSERT INTO item_cars (item_id, model_id) VALUES
  (1, 1),
  (1, 2),
  (2, 1),
  (2, 5),
  (1, 5),
  (7, 1),
  (8, 1);

INSERT INTO branches (branch_id, branch_name) VALUES
  (1, 'Dholaikhal'),
  (2, 'Godown');

-- Item 1 is kept in both branches, on two racks: 2 + 3 = 5 sets.
INSERT INTO branch_stock (stock_id, item_id, branch_id, qty, shelf) VALUES
  (1, 1, 1, 2.00, 'B-3'),
  (2, 1, 2, 3.00, 'G-1'),
  (3, 2, 1, 6.00, 'B-3'),
  (4, 3, 2, 2.00, 'D-12'),
  (5, 4, 1, 1.00, 'C-2'),
  (6, 5, 1, 1.00, 'C-2'),
  (7, 6, 1, 12.50, 'A-1'),
  (8, 7, 1, 3.00, 'B-4');

-- Item 1 has a price history: the newest row (August) is the price now.
INSERT INTO item_prices (price_id, item_id, sale_rate, workshop_rate, dealer_rate, cost_rate, effective_from) VALUES
  (1, 1, 4200.00, 3900.00, 3700.00, 3000.00, '2026-01-01'),
  (2, 1, 4500.00, 4200.00, 4000.00, 3200.00, '2026-08-01'),
  (3, 2, 1990.50, 1800.00, NULL, 1400.00, '2026-03-01'),
  (4, 3, 5500.00, 5200.00, NULL, 4000.00, '2026-03-01'),
  (5, 4, 18000.00, NULL, NULL, 15000.00, '2026-03-01'),
  (6, 5, 9000.00, 8500.00, NULL, 7000.00, '2026-03-01'),
  (7, 6, 950.00, NULL, NULL, 700.00, '2026-03-01'),
  (8, 7, 1500.00, 1400.00, NULL, 1100.00, '2026-03-01'),
  (9, 8, 1000.00, NULL, NULL, 800.00, '2026-03-01');

INSERT INTO parties (party_id, party_name, party_name_bn, party_kind, mobile, balance, is_deleted) VALUES
  (1, 'Rahman Auto Works', 'রহমান অটো ওয়ার্কস', 'Mechanic', '01700-000001', 12500.00, 0),
  (2, 'Bhai Bhai Traders', 'ভাই ভাই ট্রেডার্স', 'Dealer', '01700-000002', 30000.00, 0),
  (3, 'Mr. Karim', NULL, 'VIP', '01700-000003', 0.00, 0),
  (4, 'Walk-in Customer', NULL, 'Walk-in', NULL, 0.00, 0),
  (5, 'Old Party', NULL, 'Dealer', NULL, 100.00, 1);

INSERT INTO vendors (vendor_id, vendor_name, phone) VALUES
  (1, 'Japan Parts House', '01800-000001');
