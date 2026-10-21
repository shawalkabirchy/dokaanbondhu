-- DokaanBondhu's read-only user on the test shop (spec 11.1): SELECT only. Test values only.
CREATE USER IF NOT EXISTS 'dokaan_ro'@'%' IDENTIFIED BY 'test-backend-ro';
GRANT SELECT ON shopb.* TO 'dokaan_ro'@'%';
