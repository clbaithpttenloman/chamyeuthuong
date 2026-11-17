/**
 * Constant SQL seed statements for the 12 example Teachers' Day wishes.
 * Each INSERT uses SELECT…WHERE NOT EXISTS (meta flag) so seeds run only once.
 * The meta-flag INSERT must be last — it gates all the wish INSERTs above it.
 * Single quotes in SQL string literals are doubled ('') where the content
 * contains an apostrophe; clean Vietnamese text needs no escaping here.
 *
 * Wishes that address a single teacher use {Thầy/Cô} (sentence-start) and
 * {thầy/cô} (mid-sentence) instead of hard-coded thầy/cô so they render
 * correctly regardless of the teacher's actual title.
 * Generic "quý thầy cô" (all teachers collectively) is left as-is.
 */
export const SEEDS: string[] = [
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Tri ân thầy cô', 'Kính chúc quý thầy cô sức khỏe dồi dào, hạnh phúc tràn đầy trong ngày Nhà giáo Việt Nam 20/11.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Lời chúc 20/11', 'Nhân ngày Nhà giáo Việt Nam, em xin gửi đến {thầy/cô} {tên} lời chúc sức khỏe và thành công trong sự nghiệp trồng người.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Cảm ơn thầy cô', 'Chúc {thầy/cô} {tên} dạy môn {môn} luôn tràn đầy năng lượng và niềm vui với nghề giáo cao quý.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Kính chúc thầy cô', 'Kính chúc {Thầy/Cô} {tên} sức khỏe dồi dào và hạnh phúc. Cảm ơn {thầy/cô} đã tận tâm dìu dắt chúng em suốt những năm học vừa qua.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Biết ơn thầy cô', 'Những bài học về môn {môn} của thầy cô sẽ theo em suốt cuộc đời. Kính chúc thầy cô mạnh khỏe và an khang.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Chúc mừng 20/11', 'Chúc mừng ngày Nhà giáo Việt Nam! Kính chúc thầy cô luôn vui vẻ, khỏe mạnh và tràn đầy nhiệt huyết với sự nghiệp giáo dục.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Người thầy kính yêu', '{Thầy/Cô} {tên} kính mến! Em xin chúc {thầy/cô} sức khỏe dồi dào và mãi say mê với sự nghiệp trồng người cao quý.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Tình yêu thầy cô', 'Mỗi bài học của {Thầy/Cô} {tên} là những kỷ niệm đẹp trong hành trình trưởng thành của em. Chúc {thầy/cô} luôn hạnh phúc và bình an.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Kính chúc thầy cô', 'Em xin kính chúc thầy cô nhân ngày 20/11 luôn dồi dào sức khỏe, hạnh phúc bên gia đình và thành công trong cuộc sống.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Người thầy truyền cảm hứng', '{Thầy/Cô} {tên} đã thắp sáng trong em tình yêu với môn {môn}. Kính chúc {thầy/cô} luôn mạnh khỏe, hạnh phúc và thành công.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Tri ân và yêu thương', 'Nhân ngày Nhà giáo Việt Nam, chúng em xin gửi đến quý thầy cô lời tri ân sâu sắc và những lời chúc tốt đẹp nhất.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT INTO wish (title, body, created_at, created_by) SELECT 'Tương lai tươi sáng', 'Nhờ có thầy cô dạy dỗ môn {môn}, em tự tin bước vào tương lai. Kính chúc thầy cô sức khỏe, an khang và thịnh vượng.', datetime('now'), 'seed' WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'wishes_seeded')`,
  `INSERT OR IGNORE INTO meta (key, value) VALUES ('wishes_seeded', '1')`,
]
