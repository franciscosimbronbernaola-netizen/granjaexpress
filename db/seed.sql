-- =====================================================================
-- Granja Express Cloud - Datos de prueba (ficticios)
-- Ejecutar después de schema.sql
-- =====================================================================
INSERT INTO productos (nombre, categoria, unidad, precio, stock) VALUES
  ('Pollo entero beneficiado',   'Aves',     'kg',    11.50, 5000),
  ('Pechuga de pollo',           'Aves',     'kg',    16.90, 3000),
  ('Pierna de pollo',            'Aves',     'kg',    12.80, 3000),
  ('Alas de pollo',              'Aves',     'kg',    13.50, 2000),
  ('Pato entero',                'Aves',     'kg',    24.00, 1500),
  ('Gallina de chacra',          'Aves',     'und',   45.00,  800),
  ('Pavo entero',                'Aves',     'kg',    22.00,  600),
  ('Huevo rosado',               'Huevos',   'kg',     8.20, 6000),
  ('Huevo de codorniz x 24',     'Huevos',   'paq',    6.50, 2500),
  ('Bandeja de huevos x 30',     'Huevos',   'band',  14.50, 4000),
  ('Menudencia de pollo',        'Menudencia','kg',    6.00, 2000),
  ('Molleja de pollo',           'Menudencia','kg',    9.50, 1500),
  ('Alimento para aves 50 kg',   'Insumos',  'saco', 98.00,  400),
  ('Maíz amarillo 50 kg',        'Insumos',  'saco', 75.00,  500)
ON CONFLICT (nombre) DO NOTHING;
