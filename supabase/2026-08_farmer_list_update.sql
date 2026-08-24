-- =============================================================================
-- Farmer list update — "AI FARM DATA IN RESOURCE CENTRE (FINAL VERSION)"
-- Brings fs_farmers in line with the updated workbook: 339 -> 344 profiled
-- farmers. Safe to run more than once.
--
-- Deliberate choices:
--   * Farmer IDs are NEVER recreated. fs_visits.farmer_id points at them, so a
--     delete-and-reinsert would orphan visit history. Matched rows are UPDATEd.
--   * Two farmers were renamed in the workbook, not replaced. They are renamed
--     FIRST, by their old name, so the match below updates the same row instead
--     of inserting a duplicate:
--       - Maqhaka  'Lebohang'          -> 'Lebohang Moffman'
--         (the surname had been typed into the village column; village is now
--          corrected to Tsoili tsoili)
--       - CX       'Sekoala Makhabne'  -> 'Sekoala Makhabane'  (same phone)
--   * Farmers dropped from the workbook are DEACTIVATED, never deleted, so any
--     visit already recorded against them survives. They disappear from the FS
--     picker immediately (fs_bootstrap only returns active farmers).
--   * Only source='profiled' rows are touched. Farmers registered by Field
--     Supervisors in the app (source='fs_registered') are left alone.
-- =============================================================================

begin;

-- 1. renames, before matching ------------------------------------------------
update fs_farmers set name = 'Lebohang Moffman'
 where source = 'profiled' and site_id = 14 and name = 'Lebohang';
update fs_farmers set name = 'Sekoala Makhabane'
 where source = 'profiled' and site_id = 15 and name = 'Sekoala Makhabne';

-- 2. the workbook, as data ----------------------------------------------------
create temp table incoming (
  site_id int, name text, village text, gender text, age int,
  production text, field_size text, crops text, system text, phone text
) on commit drop;

insert into incoming values
  (1, 'Bokang Khutlisi', 'Thebesoa', 'M', 21, 'H+A', '5*3m, 10.3 Acres', 'Cabbage, Potatoe, Onion, Maize, Beans', 'Open Fields', '57265894'),
  (1, 'Kabelo Motseki', 'Thebesoa', 'M', 21, 'H+A', '8*4m, 2 Acres', 'Cabbage, Green Papper,Maize, Butternut', 'Open Fields', '59711369'),
  (1, 'Katiso Moneri', 'Mahuu', 'M', 42, 'H', '5*5 m', 'Onion,Cabbage', 'Open Fields', '57105508'),
  (1, 'Keneuoe Mohata', 'Ha Nkhokho', 'F', 30, 'H+A', '1 Acre,6 Acres', 'Cabbage,Rape, Maize,Beans', 'Open Fields', '59881897'),
  (1, 'Lefa Kotsi', 'Ha Nkhokho', 'M', 44, 'H+A', '1 Acre, 10Acres', 'Cabbage, Rape,Maize, Beans', 'Open Fields', '57531154'),
  (1, 'Lekopa Tlali', 'Mahuu', 'M', 34, 'H+A', '2 Acres, 20 Acres', 'CabbaMaize, Beansge, Rape, Tomatoe,', 'Open Fields', '53920181'),
  (1, 'Litseoane Thebesoa', 'Thebesoa', 'F', 18, 'A', '15 Acres', 'Maize,Beans,Sourghum', 'Open Fields', '53343025'),
  (1, 'Malei Tsooana', 'Ha Tlelase', 'M', 45, 'H', '3 Acres', 'Onion, Cabbage, Rape', 'Open Fields', '63395920'),
  (1, 'Malekhooa Lekhooa', 'Ha Tlali', 'F', 34, 'H+A', '30*10m, 8.9 Acres', 'Cabbage, Tomato, Green Papper, Maize, Beans', 'Open Fields', '59669792'),
  (1, 'Mapitso Mohapinyane', 'Thebesoa', 'F', 61, 'H+A', '7*10m, 4 Acres', 'Cabbage,beetroot,Spinach,Maize.', 'Open Fields', '58995333'),
  (1, 'Masipho Molapo', 'Mahuu', 'F', 52, 'H+A', '20*10m, 7 Acres', 'Green peas, Cabbage, Sourghum, Maize', 'Open Fields', '59562772'),
  (1, 'Mateboho Makutsu', 'Mahuu', 'F', 60, 'H', '20*5m, 11 Acres', 'Cabbage, butternut, Tomatoe', 'Open Fields', null),
  (1, 'Matlali Manyokole', 'Ha Tlali', 'F', 56, 'A', '14 Acres', 'Maize,Beans,Sourghum', 'Open Fields', '58067414'),
  (1, 'Matsokolo Sello', 'Ha Nkhokho', 'F', 60, 'H', '5*10 m', 'Cabbage, Rape', 'Open Fields', '57134673'),
  (1, 'Remaketse Qabano', 'Setsoantso', 'M', 69, 'H+A', '2 Acres, 10 Acres', 'Cabbage,Tomatoe, Green beans, Maize, Beans', 'Open Fields', '62867424'),
  (1, 'Rethabile Molotsi', 'Ha Nkhokho', 'F', 25, 'H+A', '1 Acre, 4 Acre', 'Cabbage, Rape, Maize, Beans', 'Open Fields', '59306170'),
  (1, 'Rorisang Mohoang', 'Thebesoa', 'M', 29, 'H', '1 Acre', 'Tomato, Green papper, Cabbage', 'Protected Agriculture', '59059782'),
  (1, 'Tseliso Nonyana', 'Ha Morakanyane', 'M', 76, 'H+A', '2 Acres, 50 Acres', 'Cabbage, Rape, Potatoe, Maize, Beans, Sourghum', 'Open Fields', '58163148'),
  (1, 'Tumisang Ramalitse', 'Mahuu', 'M', 26, 'H+A', '1 Acre, 11 Acres', 'Cabbage,beetroot,carrots, Maize, Sourghum', 'Open Fields', '62880449'),
  (2, 'Hareteke Tsheisa', 'Ha Matela', 'M', 26, 'H', '5 Acres', 'Cabbage, rape', 'Open field', '58300488'),
  (2, 'Kamohelo Molepe', 'Ha Matela', 'M', 37, 'H+A', '8 Hacters', 'Sourghum, Maize, Beans, Cabbage', 'Open field', '57207591'),
  (2, 'Katiso Sefako', 'Ha Moji', 'M', 51, 'H+A', '10 Acres', 'Cabbage, Rape, Maize, Beans,Potatoe,Sourghum', 'Open field', '58476522'),
  (2, 'Khotso khotso', 'Ha Matela', 'M', 29, 'H+A', '9 Hacters', 'Maize,Beans,Sourghum,Cabbage', 'Open field', '59928781'),
  (2, 'Makauhelo Lenkoe', 'Ha Lekhutle', 'F', 57, 'H+A', '3 Hacters', 'maize, cabbage,beans', 'Open field', '58419601'),
  (2, 'Makhiba Hlaele', 'Ha Matela', 'F', 60, 'H+A', '20.5 Acres', 'Maize, beans,Cabbage,Rape', 'Protected field & Open field', '58973728'),
  (2, 'Malineo Bosielo', 'Ha Mpiti', 'F', 50, 'H', '2 Hacters', 'Cabbage, Rape', 'Open field', '58903722'),
  (2, 'Malineo Phala', 'Ha Mpiti', 'F', 57, 'H', '5 Acres', 'cabbage, Rape', 'Open field', '57411942'),
  (2, 'Mamatseliso Moepi', 'Ha Matela', 'F', 52, 'H+A', '5.6 Hacters, 2.5 Acres', 'Maize,Beans, Cabbage', 'Open Field', '56623790'),
  (2, 'Mamokheseng Ralephai', 'Ha Moji', 'F', 50, 'H+A', '3.6 Hacters', 'Maize, beans,Cabbage,Rape', 'Open field', '57873329'),
  (2, 'Mamuso Setseo', 'Ha Mpiti', 'F', 61, 'H+A', '2.8 Hacters', 'Cabbage, Maize, Beans', 'Open field', '59652375'),
  (2, 'Manketsi Phala', 'Ha Matela', 'F', 53, 'H+A', '16.0 Acres', 'Maize,Beans,Sourghum,Cabbage', 'Open field', '53257835'),
  (2, 'Matsebiso Phala', 'Ha Matela', 'F', 42, 'H+A', '4.6 Acres', 'Maize, beans,Cabbage,Rape', 'Open field', '58419098'),
  (2, 'Matseko Ntilane', 'Ha Mpiti', 'F', 69, 'H+A', '5.4 Ha, 2.5 Acres', 'Maize,Beans,Sourghum,Cabbage', 'Open Field', '59972419'),
  (2, 'Matsokolo Tsoaeli', 'Ha Motsi', 'F', 66, 'H', '3 Hacters', 'Cabbage, Rape', 'Open field', '59637855'),
  (2, 'Mofokeng Nqosa', 'Ha Nqosa', 'M', 64, 'A', '40 Acres', 'Maize, Sourghum,Beans', 'Open field', '57320802'),
  (2, 'Monaheng Pitso', 'Ha Lekhutle', 'M', 34, 'H+A', '10 Hacters', 'Maize,sourghum,Cabbage', 'Open field', '50474972'),
  (2, 'Mpho Thamae', 'Ha Lekhutle', 'M', 26, 'H+A', '5 Hacters', 'Cabbage, Rape, Maize', 'Open field', '59665613'),
  (2, 'Neo Phala', 'Ha Matela', 'M', 47, 'H+A', '2 Hacters', 'Sourghum, Maize, Beans, Cabbage, Rape', 'Open field', '53502511'),
  (2, 'Sebuoeng Khotso', 'Ha Moji', 'F', 42, 'A', '2.7 Hacters', 'Maize , beans', 'Open field', '58149356'),
  (2, 'Thabang Lekhutlo', 'Ha Matela', 'M', 66, 'A', '7 Acres', 'Maize,Beans, Sourghum', 'Open Field', '50097725'),
  (2, 'Tlotliso Ndaba', 'Ha Lekhutle', 'M', 25, 'H', '6 Hacters', 'cabbage,Rape, green papper', 'Protected field', '58586598'),
  (2, 'Tseliso Letsie', 'Ha Matela', 'M', 60, 'H+A', '7 Hacters', 'Cabbage, Rape, Maize, Beans,Sourghum', 'Open field', '58759772'),
  (3, 'Bafokeng Mabone', 'Likalaneng', 'M', 52, 'A', '4.7 Acres', 'Maize, Potatoes', 'Open Field', '59023126'),
  (3, 'Lefu Mohale', 'Likalaneng', 'M', 55, 'A', '1.2 Acres', 'Maize, Potatoes', 'Open Field', null),
  (3, 'Lekhotla Chabeli', 'Likalaneng', 'M', 55, 'A', '3.2 Acres', 'Maize, Potatoes', 'Open Field', '57162196'),
  (3, 'Lerato Kabi', 'Likalaneng', 'M', 56, 'A', '2.3 Acres', 'Maize, Potatoes', 'Open Field', '50589291'),
  (3, 'Liau Shai', 'Likalaneng', 'M', 25, 'A', '3.7 Acres', 'Maize, Potatoes', 'Open Field', '56363734'),
  (3, 'Liphapang Lekata', 'Likalaneng', 'M', 66, 'H', '2.2 Acres', 'Potatoes', 'Open Field', '58404485'),
  (3, 'Mahonyatsa Moshoeshoe', 'Likalaneng', 'M', 50, 'A', '2 Acres', 'Maize, Potatoes', 'Open Field', '50885765'),
  (3, 'Malefu Ntjantja', 'Likalaneng', 'F', 52, 'A', '3.2 Acres', 'Maize, Potatoes', 'Open Field', '53245098'),
  (3, 'Mamontseng Mohale', 'Likalaneng', 'F', 64, 'H', '2.4 Acres', 'Potatoes,Cabbage,Rape,tomatoe', 'Open Field', '56901772'),
  (3, 'Manteliseng Khatleli', 'Likalaneng', 'F', 62, 'A', '3.4 Acres', 'Maize, Potatoes', 'Open Field', '57245990'),
  (3, 'Manthabiseng Moorosi', 'Likalaneng', 'F', 48, 'A', '2.3 Acres', 'Maize, Potatoes', 'Open Field', '59876965'),
  (3, 'Mataelo Hlaele', 'Likalaneng', 'F', 56, 'A', '1 Acre', 'Maize, Potatoes', 'Open Field', '53675940'),
  (3, 'Matankiso Metsing', 'Likalaneng', 'F', 46, 'A', '2 Acres', 'Maize, Potatoes', 'Open Field', '50163560'),
  (3, 'Mokhoenene Takatso', 'Likalaneng', 'M', 57, 'A', '2 Acres', 'Maize, Potatoes', 'Open Field', '58561902'),
  (3, 'Ntsoaki Mahabane', 'Likalaneng', 'F', 29, 'A', '3 Acres', 'Maize, Potatoes', 'Open Field', '56636268'),
  (3, 'Nyatso Moreboli', 'Likalaneng', 'M', 61, 'A', '4.3 Acres', 'Maize, Potatoes', 'Open Field', '59484950'),
  (3, 'Pobeng Pule', 'Likalaneng', 'M', null, 'A', '1.5 Acres', 'Maize, Potatoes', 'Open Field', null),
  (3, 'Sempe Mosito', 'Likalaneng', 'M', 54, 'H', '1 Acre', 'Potatoes', 'Open Field', null),
  (3, 'Teboho Takatso', 'Likalaneng', 'M', 52, 'A', '1.9 Acres', 'Maize, Potatoes', 'Open Field', '59780551'),
  (3, 'Tsotang Piti', 'Likalaneng', 'M', 60, 'A', '1.8 Acres', 'Maize, Potatoes', 'Open Field', '58585526'),
  (4, 'Khotso Maphate', 'Ha Toloane', 'M', 26, 'H', '60*60m', 'Tomatoes, Cabbage', 'Open field', '56015757'),
  (4, 'Liako Letsie', 'Vukazenzela', 'F', 31, 'H', '1.5 Acres', 'Cabbage,Onion,tomatoes,carrots,garlicbeetroot', 'Open field', '56511998'),
  (4, 'Lisebo Moshabesha', 'Ha Majane', 'F', 35, 'H', '1 Acres', 'Pumpkin,tomatoes,onion,garlic', 'Open field', '63411108'),
  (4, 'Makheleli Matsoso', 'Matsieng', 'F', 23, 'H', '0.8 Acres', 'Cabbage, carrots,onion', 'Open field', '59981023'),
  (4, 'Malebaka Tsoeu', 'Ha mokhuthoane(Mekateng)', 'F', 45, 'H', '1 Acres', 'Cabbage, Rape,Spinach', 'Open field', '58987705'),
  (4, 'Malehlohonolo Mohoebi', 'Mauteng', 'F', 27, 'H', '1.2 Acres', 'Cabbage,rape,carrots,beetroot', 'Open field', '57215819'),
  (4, 'Malehlohonolo Setona', 'Mauteng', 'F', 35, 'H', '4.2 Acres', 'Cabbage,Potatoes,Tomatoes', 'Open field', '57350457'),
  (4, 'Mamolefi Mokitimi', 'Ha Moruthoane', 'F', 50, 'A', '7.4 Acres', 'Maize, Sourghum,beans', 'Open field', '58077516'),
  (4, 'Mampho Rasoai', 'Phahameng', 'F', 43, 'H', '10.5 Acres', 'Cabbage,Potatoes,Tomatoes', 'Open field', '59919332'),
  (4, 'Marafaele Nkholi', 'Ha mokhuthoane', 'F', 33, 'A', '4.8 Acres', 'Maize,beans', 'Open field', '56885240'),
  (4, 'Matanki Letele', 'Matsieng', 'F', 25, 'H', '1 Acres', 'green,pepper,spinach,cabbage', 'Open field', '56140393'),
  (4, 'Matsela Mokole', 'Vukazenzela', 'F', 27, 'A', '4.4 Acres', 'Beetrot, Onion,tomatoe,garlic,carrots', 'Protected', '62073348/53509811'),
  (4, 'Mojalefa Tsekiso', 'Ha Majane', 'M', 34, 'A', '62.5 Acres', 'Maize, Sourghum,beans', 'Open field', '57709174'),
  (4, 'Motseki Mahloko', 'Matsieng (Tsitsa)', 'F', 37, 'A', '20*20m', 'cabbage,beetroot,onion', 'Open field', '53380756'),
  (4, 'Paulo Mohlomi', 'Ha Moruthoane (Mekateng)', 'M', 48, 'H', '1 Acres', 'Onion,Cabbage,Rape', 'Open field', '59728112'),
  (4, 'Rethabile Seliane', 'Phahameng', 'M', 34, 'H', '3.2 Acres', 'Onion,butternut,tomatoes', 'Open field', '57727026'),
  (4, 'Retselisitsoe Nthaha', 'Matsieng', 'M', 35, 'H', '4 Acres', 'Cabbage, tomatoes', 'Open field', '57670405'),
  (4, 'Rorisang Tlali', 'Matsieng', 'M', 30, 'H', '2 Acres', 'Cabbage, carrots,onion', 'Open field', '59942922'),
  (4, 'Tsepang Setheka', null, 'M', 34, 'H', '2 Acres', 'Cabbage,Tomatoes', 'Open field', '57778985'),
  (4, 'Tumelo Moea', 'Matsieng', 'M', 27, 'H', '1 Acres', 'beetroot,rape,carrots,cabbage', 'Open field', '59040276'),
  (5, 'Hlankana Mahlelebe', 'Nyakosoba', 'M', 39, 'H', '1.2 Acres', 'Cabbage,rape,Carrots', 'Open Field', '50307838'),
  (5, 'Khahliso Lekhehle', 'Nyakosoba', 'M', 37, 'A', '7 Acres', 'Potatoes, Maize', 'Open Field', '57953107'),
  (5, 'Mabasia Sephelane', 'Nyakosoba', 'F', 71, 'H', '4 Acres', 'Cabbage', 'Open field', '63197875'),
  (5, 'Mafata Matli', 'Nyakosoba', 'M', 40, 'H', '2 Acres', 'Cabbage, potatoes', 'Open Field', '62008760'),
  (5, 'Majubile Makakole', 'Nyakosoba', 'F', 39, 'A', '1.2 Acres', 'Maize,Beans,Sourghum', 'Open Field', '59718934/63043447'),
  (5, 'Malefane Mosala', 'Nyakosoba', 'M', 29, 'A', '3 Acres', 'Maize, Beans,sourghum', 'Open Field', '53529060'),
  (5, 'Maliphoto Liphoto', 'Nyakosoba', 'F', 57, 'A', '7 Acres', 'Maize, Beans', 'Open Field', '68109612'),
  (5, 'Mambokoase Mokoma', 'Nyakosoba', 'F', 42, 'H', '0.8 Acres', 'carrots,beetroot,rape,green beans,cabbage', 'Open Field', '57265893'),
  (5, 'Maqheka Matli', 'Nyakosoba', 'M', 26, 'A', '5 Acres', 'Maize,Beans', 'Open Field', null),
  (5, 'Molemo Mofundisi', 'Nyakosoba', 'M', 40, 'A', '7.5 Acres', 'Potatoes,Maize,Beans', 'Open Field', '62230455'),
  (5, 'Morenamang Lekhema', 'Nyakosoba', 'M', null, 'H', '1 Acre', 'potatoes,Cabbage,Rape', 'Open Field', '56185607'),
  (5, 'Nthabiseng Chele', 'Nyakosoba', 'F', 30, 'H', '2 Acres', 'Cabbage,tomato,Onion,green pepper,chillis', 'Open Field + Protected', '50910772'),
  (5, 'Patja Mokoma', 'Nyakosoba', 'M', 43, 'A', '11 Acres', 'Maize, Beans', 'Open Field', '58150353'),
  (5, 'Ralikoto Mokoma', 'Nyakosoba', 'M', 60, 'H', '16*23, 30*10m', 'Cabbage,rape,tomatoe,Carrots', 'Protected', '63065675/57885311'),
  (5, 'Retselisitsoe Mokoma', 'Nyakosoba', 'M', 24, 'H', '4 Acres', 'Potatoes', 'Open Field', '57639733'),
  (5, 'Richard Shakhane', 'Nyakosoba', 'M', 36, 'H', '8 Acres', 'potatoes,Cabbage,Rape', 'Open Field + Protected', '56354965'),
  (5, 'Sello Thibile', 'Nyakosoba', 'M', 63, 'A', '3 Acres', 'Maize,Sourghum, Beans', 'Open Field', '57036623'),
  (5, 'Tseliso Malefane', 'Nyakosoba', 'M', 23, 'H', '30*20m', 'Cabbage,rape,spinach', 'Open Field', '56769112'),
  (5, 'Tsepang Chele', 'Nyakosoba', 'F', null, 'A', '2 Acres', 'Maize, Beans', 'Open Field', '58540460'),
  (5, 'Tsepang Tsela', 'Nyakosoba', 'M', null, 'A', '2.1 Acres', 'Maize,beans', 'Open Field', '58181110'),
  (6, 'Boitumelo Molikeng', 'Thoteng', 'M', 19, 'A', '1.1 Acres', 'Potatoes', 'Open Field', '572884494'),
  (6, 'Keketso Mawene', 'Ha Maphohloane', 'M', 30, 'H', '1 Acre', 'Cabbage, Rape,Spinach', 'Open Field', '56499064'),
  (6, 'Keneuoe Lephatsoe', 'Mataoeng', 'F', 26, 'A', '4.1 Acres', 'potatoes', 'Open Field', '53109173'),
  (6, 'Liemiso Sepeqone', 'Ha Sekoati', 'F', 22, 'H', '60*50m', 'green pepper, carrots,cabbage', 'Open Field', '57872362'),
  (6, 'Malebohang Mokoaleli', 'Ha Potsane', 'F', 39, 'H', '2.4 Acres', 'carrots, beetroot, green papper, cabbage', 'Open Field', '51996022'),
  (6, 'Manyahe Kotelo', 'Ha Maphohloane', 'M', 23, 'H', '2 Acres', 'Cabbage,Rape,Tomatoes', 'Open Field + Protected', '58145438/62089183'),
  (6, 'Marapelang Mokoaleli', 'Qalakheng', 'F', 34, 'H', '1.5 Acre', 'Cabbage, Spinach, Rape', 'Open Field', '59411385'),
  (6, 'Mekoane Makatiso', 'Likhutlong', 'F', 51, 'H', '3 Acres', 'Cabbage, Rape,Spinach', 'Open Field', '59952668'),
  (6, 'Moeketsi Mohlathe', 'Ha Sehloho', 'M', 30, 'A', '2.8 Acres', 'Maize', 'Open Field', '59577852'),
  (6, 'Mpokanyo Mabula', 'Qalakheng', 'F', 29, 'A', '2 Acre', 'Potatoes', 'Open Field', '50819415'),
  (6, 'Naleli Rakuba', 'Qalakheng', 'M', 26, 'H', '2.1 Acres', 'tomatoes, green ppper,carrots, beetroot', 'Open Field', '51669155/62997431'),
  (6, 'Napo Makhasane', 'Thotaneng', 'M', 24, 'A', '4.9 Acres', 'beans', 'Open Field', '57393129'),
  (6, 'Pheta Mohale', 'Ha Potsane', 'M', 39, 'H', '4 Acres', 'Cabbage, Rape,Spinach, green pepper', 'Open Field', '58145991'),
  (6, 'Sehloho Ntsekalle', 'Ha Maphohloane', 'M', 35, 'A', '1Acre', 'Maize,beans', 'Open Field', '62710532'),
  (6, 'Sello Ralintsane', 'Ha Pota', 'M', 46, 'A', '6.4 Acres', 'Maize,beans, Soughum', 'Open Field', '58944916'),
  (6, 'Sempe Lebona', 'Nkhu- Nkhu', 'M', 46, 'H', '3 Acres', 'carrots, beetroot, green papper, cabbage', 'Protected', '56848590'),
  (6, 'Teboho Khoalinyane', 'Katlehong', 'M', 29, 'H', '3.6 Acres', 'tomatoes, green ppper,carrots, beetroot', 'Open Field', '56801196'),
  (6, 'Thabo Mahomed', 'Mataoeng', 'M', 32, 'H', '1 Acre', 'Cabbage, Rape,Spinach', 'Open Field', '53087961'),
  (6, 'Tlotliso Matlosa', 'Ha Bolokoe', 'M', 28, 'A', '3 Acres', 'Maize, Potatoes, Beans', 'Open Field', '58581061/69058233'),
  (6, 'Tsepo Sello', 'Ha Tsepo', 'M', 35, 'H', '3.5 Acres', 'carrots, beetroot, green papper, cabbage', 'Open Field', '56425855'),
  (7, 'Akhona Bohlani', 'Ha soko', 'F', 25, 'A', '1.4 Acres', 'Potatoes', 'Open field', '57857665'),
  (7, 'Andiswa Ntloko', 'Likhakeng', 'F', 36, 'A', '1.2 Acres', 'Potatoes', 'Open field', '69127198'),
  (7, 'Buang Mafisa', 'Motse mocha', 'M', 59, 'A', '12.8 Acres', 'Maize, Beans', 'Open field', '59740494'),
  (7, 'Keketso Mpasi', 'Thabaneng', 'M', 33, 'A', '2 Acres', 'Maize', 'Open field', '57585341'),
  (7, 'Lehlohonolo Rankali', 'Bereng- Matsoho', 'M', 42, 'A', '2 Acres', 'Maize, Beans', 'Open field', '57861660'),
  (7, 'Mahlathene Motsoikha', 'Mpharane Braakfontein', 'M', 56, 'H', '40*60m', 'Cabbage, beetroot, spinach, carrots', 'Open field', '57214090'),
  (7, 'Makhosanele Lesenya', 'Rush Braakfontein', 'M', 34, 'H', '71*30m', 'Green pepper, Cabbage,tomatoe,rape', 'Open field', '57039419'),
  (7, 'Malintle Fofa', 'Ha Mohlakana', 'F', 46, 'A', '4 Acres', 'Maize, Potatoes,Beans', 'Open field', '50760266'),
  (7, 'Manthabiseng Thebane', 'Motse mocha', 'F', 54, 'H', '10*13m', 'Cabbage,spinach,tomatoe', 'Protected', '59056300'),
  (7, 'Matholoana Letoao', 'Morifi Ha Khosi', 'F', 29, 'H', '0.5 Acres', 'Rape,Cabbage', 'Open field', '56259668'),
  (7, 'Matlama Ntsibolane', 'Ha setotoma', 'M', 31, 'H', '60*30', 'Cabbage,tomatoe', 'Open field', '56544855'),
  (7, 'Nketsi Jane', 'Likhakeng', 'M', 55, 'H', '20*30m', 'Cabbage', 'Open field', '62913341'),
  (7, 'Ramokali Ramontsane', 'Meriting', 'M', 75, 'A', '1.7 Acres', 'Maize', 'Open field', '59912672'),
  (7, 'Rosinah Moeketsi', 'Ha ntili Braakfontein', 'F', 68, 'A', '2.9 Acres', 'Beans', 'Open field', '58901041'),
  (7, 'Sebopeho Phofu', 'Brakfontein', 'M', 25, 'A', '1 Acre', 'Potatoes', 'Open field', '63362343'),
  (7, 'Sehloho Moleleki', 'Ha jobo', 'M', 78, 'A', '4 Acres', 'Maize,sourghum', 'Open field', '58184793'),
  (7, 'Thabang Tsolo', 'Mpharane Braakfontein', 'M', 67, 'H', '0.5 Acres', 'Rape,Cabbage', 'Open field', '59144987'),
  (7, 'Tholang Koele', 'Holy cross Phuthing', 'M', 50, 'A', '6 Acres', 'Maize, Beans, Peas', 'Open field', '58474984'),
  (7, 'Tlokotsi Lehloenya', 'Thabaneng', 'M', 28, 'H', '0.7 Acres', 'Cabbage', 'Open field', '50397647'),
  (7, 'Tsotang Sefuthi', 'Morobong', 'M', 31, 'H', '40*50m', 'Cabbage, beetroot, carrots', 'Open field', '59059190'),
  (8, 'Free Malebela', 'Motimposo', 'M', 35, 'H', '30*30*2', 'Cabbage', 'Open Field', '50048178'),
  (8, 'Kefuoe Mopeli', 'Masaleng', 'M', 35, 'H', '30*30,3*30', 'Onion,Cabbage,Rape', 'Open Field', '69358222'),
  (8, 'Maqhoaesane Masao', 'Motimposo', 'F', 70, 'H', '2 Acres', 'Cabbage,onion,chillis,carrots,potatoes', 'Protected + Open', null),
  (8, 'Masefale Mahase', 'Masaleng', 'F', 44, 'H', '2 Acres', 'Cabbage, Spinach,Rape,beetroot,carrots', 'Protected + Open', '58465999'),
  (8, 'Matseke Ralebakeng', 'Masaleng', 'M', 44, 'H', '2.7 Acres', 'Green pepper,tomatoes,cabbage', 'Protected', '63446485'),
  (8, 'Mpho Mokunutlu', 'Ha Tjopa', 'M', 28, 'H', '1 Acres', 'Onion,beetroot,carrots', 'Open Field', '62519353'),
  (8, 'Rampa Khabi', 'Moreneng', 'M', 69, 'H', '60*120', 'Cabbage, rape, spinach,tomatoe', 'Protected', '56880400'),
  (8, 'Rethabile Mofana', 'Ha Mmusi', 'M', 25, 'H', '100*40m', 'Cabbage,rape,spinach,tomatoe,watermelon,butternut', 'Protected + Open', '58135705'),
  (8, 'Teboho Mafa', 'Motimposo', 'F', 30, 'H', '1.2 Acres', 'Cabbage, rape, spinach', 'Open Field', '59584741'),
  (8, 'Tumelo Matabola', 'Ha Eleck', 'M', 27, 'H+A', '9 Acres', 'Maize, Cabbage, Spinach,Rape,beetroot,carrots', 'Open Field', '53828709'),
  (9, 'Makemiso Mohalali', 'Tabola', 'F', 57, 'H', '30*30', 'Butternut,Onion,beetroot,rape,carrots', 'Open Field', '53626990'),
  (9, 'Mamorakane Mokhele', 'Ha Ramosalla', 'F', 47, 'H', '3 Acres', 'Cabbage,beetroot,carrots,onion', 'Open Field', '53713387'),
  (9, 'Mankoe Mapikitla', 'Tabola', 'M', 57, 'A', '3.6 Acre', 'Maize,Beans', 'Open Field', '57373424'),
  (9, 'Manoeli Motsie', 'Tabola', 'M', 26, 'H', '48*20,0.55 Acres', 'Cabbage,cucumber,water melon', 'Open Field', '58478598'),
  (9, 'Mpho Ramosalla', 'Ha Ramosalla', 'M', 58, 'H', '1 Acre, 10*12m', 'Cabbage,potatoe,beetroot', 'Open Field', '58018718'),
  (9, 'Patrick Mapikitla', 'Ha Fako', 'M', 45, 'A', '5 Acres', 'Maize,Beans', 'Open Field', '53654656'),
  (9, 'Retselisitsoe Matla', 'Tabola', 'M', 36, 'H', '1.8 Acres', 'Tomatoe, Cabbage, Butternut', 'Open Field', '58550569/63249460'),
  (9, 'Teboho Kibane', 'Tabola', 'M', 51, 'H', '40*20', 'Cabbage, rape', 'Open Field', '57050196'),
  (9, 'Tsepo Mafereka', 'Tabola', 'M', 30, 'A', '50*50m', 'Maize', 'Open Field', '56253647'),
  (9, 'Tsoeu Lekarapa', 'Tabola', 'M', 28, 'H', '0.7 Acre', 'Cabbage,Onion,rape,beetroot', 'Open Field', '58504025'),
  (10, 'Leabuoa Mapheelle', 'Naleli', 'M', 59, 'A', '9.4 Acres', 'Maize,sourghum,beans,cabbage', 'Open field', '58007278'),
  (10, 'Likhoa Likhoa', 'Ha Mohale', 'M', null, 'H', '42*24+42*40+40*96+19Acres', 'cabbage, tomatoe,rape,green papper,lettuce,red cabbage, cabbage', 'Protected + Open', '59920242'),
  (10, 'Maelia Khabele', 'Ha Khabo', 'F', 71, 'A', '3 Acres', 'Maize,Beans,sourghum', 'Open field', '59114940'),
  (10, 'Mafereka Mafereka', 'Konkotia', 'M', 41, 'A', '6 Acres', 'Maize, Sourghum, beans', 'Open field', '688088826'),
  (10, 'Maitumeleng Letsina', 'Konkotia', 'F', 52, 'A', '4 Acres', 'sourghum', 'Open field', '59435754'),
  (10, 'Makatleho Khati', 'Ha Ntsoakele', 'F', null, 'H', '30*30m', 'Cabbage,tomatoes,pepper', 'Protected', '69176238'),
  (10, 'Malirontso Monaheng', 'Ha Mohale', 'F', null, 'H', '1.1 Acres', 'Cabbage,peas,butternut,onion,beetroot,carrots', 'Protected', '58732522'),
  (10, 'Mamonyane Teboho', 'Konkotia', 'M', 47, 'H', '1 Acres', 'Cabbage,rape,tomato,green papper', 'Open field', '56855559'),
  (10, 'Matabeta Mona', 'Ha Khabo', 'F', 33, 'H', '30*29', 'Cabbage,tomato,rape', 'Protected', '63435372'),
  (10, 'Mathuso Sefubahali', 'Naleli', 'F', 46, 'H', '2 Acres', 'Cabbage, rape', 'Open field', '59028985'),
  (10, 'Moetsuoa Hlothoane', 'Ha Khabo', 'F', 56, 'A', '2.8 Acres', 'Maize,Beans,sourghum', 'Open field', '58066347'),
  (10, 'Mohale Khabo', 'Ha Khabo', 'M', 73, 'A', '52 Acres', 'Maize, sourghum', 'Open field', '58857178'),
  (10, 'Moorosi Nalane', 'Tau lia rora', 'M', 57, 'A', '1 Acre', 'Maize', 'Open field', '59357164'),
  (10, 'Motlatsi Khauta', 'Mahlabatheng', 'M', 33, 'A', '6 Acres', 'Maize, Sourghum', 'Open field', '68213147/59730658'),
  (10, 'Motsoalloa Sekese', 'Hata butle', 'M', 45, 'H', '24*20+35*24', 'cabbage, tomatoe,rape,green papper', 'Protected', '63973926'),
  (10, 'Nchochone Mamasiane', 'Naleli', 'M', 55, 'A', '7.5 Acres', 'Beans,Maize,Sourghum', 'Open field', '59190641'),
  (10, 'Puthehong Ntholeng', 'Ha Khabo', 'M', 55, 'H', '1 Acre', 'Cabbage,tomatoes,pepper,beetroot', 'Open field', '58488949'),
  (10, 'Sankoela Sankoela', 'Ha Khabo', 'M', 43, 'A', '2.2 Acres', 'Maize, beans,cabbage', 'Open field', '68967973'),
  (10, 'Tseliso Paulosi', 'Ha mali', 'M', 62, 'A', '1.5 Acres', 'Maize, sourghum', 'Open field', '51421593'),
  (10, 'Tsiame Ntele', 'Ha Maru a-tona', 'M', 60, 'H', '0.9 Acres', 'Cabbage,rape,tomato,green papper', 'Open field', '59906653'),
  (11, 'Lekhetho Moroma', 'Ha Abiele', 'M', 32, 'A', '4 ACres', 'Potatoes,sourghum,Maize', 'Open field', '56609877'),
  (11, 'Limakatso Habasisa', 'Ha Sepono', 'M', 51, 'A', '18 Acres', 'Potatoes,sourghum,beans,Maize', 'Open field', '56157397'),
  (11, 'Machaka Mfundisi', 'Komeng', 'F', 38, 'A', '1.5 Acres', 'Maize, Sourghum', 'Open field', '58462465'),
  (11, 'Maduduzile Mokete', 'Makhetloane', 'F', 23, 'A', '3 Acres', 'Sourghum, Maize', 'Open field', '57040150'),
  (11, 'Mahlomola Makalo', 'Ha Sepono', 'F', 54, 'A', '6 Acres', 'Maize, sourghum', 'Open field', '57034006'),
  (11, 'Mahlompho Ramaisa', 'Ha Abiele', 'F', 43, 'A', '2.4 Acres', 'Maize,Potatoes,Sourghum', 'Open field', '62612190/53734941'),
  (11, 'Maitumeleng Molapo', 'Betha-betha', 'F', 47, 'H', '1 Acre', 'Cabbage, Rape', 'Open field', '58584965'),
  (11, 'Makhohaka Sepono', 'Ha Abiele', 'F', 34, 'H', '0.8 Acres', 'Cabbage, Rape', 'Open field', '56368951'),
  (11, 'Malihotetso Molapo', 'Ha Abiele', 'F', null, 'A', '7.1 Acres', 'Maize, sourghum,Beans,Potatoes', 'Open field', '58151706'),
  (11, 'Mamalefane Semela', 'Ha Malefane', 'F', 42, 'A', '5.4 Acres', 'Maize, sourghum', 'Open field', '57216952'),
  (11, 'Mamatli Lekhehla', 'Ha seetsa', 'F', 39, 'A', '1.2 Acres', 'Cabbage, Rape', 'Open field', '50155100'),
  (11, 'Mampinane Ratjeka', 'Ha seetsa', 'F', 35, 'A', '3 Acres', 'Maize, sourghum', 'Open field', '56398582'),
  (11, 'Mantebaleng Lelefa', 'Ha Abiele', 'F', 49, 'A', '3.1 Acres', 'Maize, sourghum', 'Open field', '53568462'),
  (11, 'Mapalesa Lehlohonolo', 'Ha Abiele', 'F', 60, 'A', '7 Acres', 'potatoes, Maize,sourghum', 'Open field', '59916902'),
  (11, 'Mokete Mothopeane', 'Mokhetloane', 'M', 60, 'A', '2 Acres', 'Maize, Beans Sourghum', 'Open field', '58445385'),
  (11, 'Monyamane Rakoro', 'Komeng', 'M', 56, 'A', '4 ACres', 'Maize,Wheat,Beans,Sourghum', 'Open field', '62573934'),
  (11, 'Motlatsi Mathaha', 'Ha seetsa', 'M', 50, 'H', '1 Acres', 'Cabbage,rape', 'Open field', '56085468'),
  (11, 'Smith Makhalemele', 'Rahelo', 'M', 60, 'A', '3 Acres', 'Potatoes', 'Open field', '56990776'),
  (11, 'Thabo Rakoro', 'Ha seetsa', 'M', 63, 'A', '4 Acres', 'Maize,beans,Sourghum', 'Open field', '58141530'),
  (11, 'Tumelo Motsie', 'Betha-betha', 'M', 31, 'H', '2 Acres', 'Cabbage,tomatoes,rape', 'Open field', '57162114'),
  (12, 'Fatso Fatso', 'Ha Bale', 'F', 22, 'A', '16.3 Acres', 'Maize, Beans, Potatoes', 'Open field', '62916601'),
  (12, 'Hlajoane Tjatji', 'Ha Mpoba', 'M', 50, 'A', '8.5 Acres', 'Sourghum', 'Open field', '50159333'),
  (12, 'Khahliso Mahlatsi', 'Ha Masheane', 'M', 43, 'A', '3.2 Acres', 'Maize', 'Open field', '57601327'),
  (12, 'Khojane Machake', 'Ha Ramajoro', 'M', 52, 'A', '5.7 Acres', 'Maize', 'Open field', '58565782'),
  (12, 'Lebohang Kaota', 'Ha Bale', 'F', 69, 'A', '6.1 Acres', 'Sourghum, Beans, Maize', 'Open field', '53158045'),
  (12, 'Maanye Machabalala', 'Ha Ramajoro', 'F', 38, 'A', '5.6 Acres', 'Maize,Sourghum,beans', 'Open field', '68739108'),
  (12, 'Machere Lesala', 'Ha Bale', 'F', 53, 'A', '18 Acres', 'Maize,Sourghum,beans', 'Open field', '59491837'),
  (12, 'Mamokhanye Monyane', 'Ha Lerotholi', 'F', 42, 'H', '0.8 Acres', 'Cabbage, Potatoe', 'Open field', '58097238'),
  (12, 'Manyabeane Ntole', 'Ha Matjotjo', 'M', 38, 'A', '7.8 Ares', 'Maize,Sourghum,Potatoes, Beans', 'Open field', '56698470/62099677'),
  (12, 'Mapotlaki Moholobela', 'Ha Moholobela', 'F', 58, 'H+A', '13.2 Acres', 'Soughum,Beans,Cabbage ,Tomatoe', 'Protected + Open', '59559316'),
  (12, 'Mapuseletso Kholopane', 'Ha Ramajoro', 'F', 60, 'A', '2 Acres', 'Maize', 'Open field', '56672298'),
  (12, 'Mathato Khutsoane', 'Ha Kome', 'F', 28, 'A', '5.6 Acres', 'Maize,Beans', 'Open field', '63907974'),
  (12, 'Matsepang Khabo', 'Ha Bale', 'F', 69, 'A', '4.2 Acres', 'Maize,Sourghum,beans', 'Open field', '56979751'),
  (12, 'Motsamai Mosili', 'Ha Ramajoro', 'M', 49, 'A', '4.5 Acres', 'Maize, Beans', 'Open field', '59372703'),
  (12, 'Naleli Matlosa', 'Ha Mohasholane', 'M', 32, 'A', '10.2 Acres', 'Maize,Sourghum,Potatoes', 'Open field', '56609747'),
  (12, 'Rampooana Mantsikoe', 'Ha Lethokonyane', 'F', 41, 'H', '3.3 Acres', 'Cabbage, Onion, Potatoe', 'Open field', '57890772'),
  (12, 'Teboho Mocheba', 'Ha Bale', 'M', 29, 'H', '0.8 Acres', 'butternurt,Cabbage,rape', 'Open field', '50325208'),
  (12, 'Ts''ele Molai', 'Ha Bale', 'F', 22, 'A', '3.5 Acres', 'Maize,Sourghum,beans', 'Open field', '59407374'),
  (12, 'Tsoeu Molise', 'Ha Rakabaele', 'M', 41, 'A', '10.9 Acres', 'Sourghum, Beans', 'Open field', '56563450'),
  (12, 'Tsoeunyane Likoto', 'Ha Tsikoane', 'M', 53, 'H', '1.1 Acres', 'Cabbage', 'Open field', '51429020'),
  (13, 'Kaung Sennane', 'Ntloana-tsoana', 'M', 70, 'A', '4 Acres', 'Maize, Beans', 'Open Field', '58669905'),
  (13, 'Lefume Monethi', 'Paraise', 'M', 35, 'H', '4 Acres', 'butternut,tomatoe,Pepper,Rape,Cabbage', 'Open Field', '57172124'),
  (13, 'Leloko Maopesa', 'Ha Mafaesa', 'M', 65, 'H', '3 Acres', 'beetroot,carrots,tomatoe,pepper,onion', 'Open Field', '53925551'),
  (13, 'Liau Ntsaila', 'Ha Letlatsa', 'M', 40, 'A', '4 Acres', 'Beans', 'Open Field', '59550296'),
  (13, 'Limpho Malebo', 'Paraise', 'F', 59, 'A', '4.89 Acres', 'Maize, Beans', 'Open Field', '58092522'),
  (13, 'Liphapang Pitse', 'Paraise', 'M', 66, 'H', '2 Acres', 'Carrots,cabbage,beetroot,pepper', 'Open Field', '58300508'),
  (13, 'Litsietsi Monyeke', 'Paraise', 'M', 57, 'A', '15 Acres', 'Maize, Beans', 'Open Field', '59593656'),
  (13, 'Malekhooa Lekhooa', 'Ha Mafaesa', 'F', 40, 'H', '1 Acres', 'Cabbage,Rape,Green Pepper,tomatoe', 'Open Field', '57644373'),
  (13, 'Malemphane Lenka', 'Paraise', 'F', 67, 'A', '10 Acres', 'Maize,Beans,', 'Open Field', '63786124'),
  (13, 'Malerato Masienyane', 'Mosenekeng', 'F', 46, 'H', '900sqm', 'Carrots,tomatoe,beetroot,pepper', 'Open Field', '68991824'),
  (13, 'Manthabiseng Lekoala', 'Masaleng', 'F', 57, 'H', '1.3 Acres', 'Carrots,cabbage,beetroot,pepper', 'Open Field', '59086693'),
  (13, 'Mapheello Maqala', 'Paraise', 'F', 58, 'A', null, 'Maize, Beans', 'Open Field', '58057684'),
  (13, 'Maruping Mothae', 'Ha Letlatsa', 'M', 56, 'A', '2 Acres', 'Maize,Beans,', 'Open Field', '58881570'),
  (13, 'Napo Mokheleli', 'Baruting', 'M', 80, 'A', '2 Acres', 'Maize, Beans', 'Open Field', '58857061'),
  (13, 'Phatela Sekantsi', 'Sekojane', 'M', 50, 'A', '11 Acres', 'Maize,Beans,Sourghum', 'Open Field', '58655125'),
  (13, 'Pule Ntsaila', 'Ha Letlatsa', 'M', 57, 'A', '1 Acre', 'Maize,Beans,', 'Open Field', '58103593'),
  (13, 'Rethabile Mohapi', 'Lekhalong', 'M', 35, 'H', '2 Acres', 'Cabbage,rape,pepper', 'Open Field', '57057354'),
  (13, 'Seahle Letsie', 'Phuleng', 'M', 45, 'H', '2 Acres', 'beetroot,carrots,tomatoe,pepper', 'Open Field', '58718694'),
  (13, 'Seipati Mabea', 'Baruting', 'F', 33, 'H', '0.8 Acres', 'carrots,pepper,tomatoe', 'Open Field', '59130923'),
  (13, 'Tseliso Moseme', 'Motsekuoa', 'M', 70, 'H', '2.5 Acres', 'Cabbage,Rape,carrots,beetroot,tomatoe', 'Open Field', '57840709'),
  (14, 'Khafa Ntsebe', 'Ha Molefi', 'M', 40, 'A', '3.5 Acres', 'Maize, Sourghum', 'Open field', '59542422'),
  (14, 'Lebohang Moffman', 'Tsoili tsoili', 'M', 36, 'H', '1.2 Acres', 'Cabbage,rape,spinach,pepper', 'Open field', '53194031'),
  (14, 'Makananelo Rangoako', 'Ha Shadrack', 'F', 45, 'H+A', '22 Acres', 'Cabbage,tomatoe,Maize,sourghum,beans,potatoes,watermellon', 'Open Field + Protected', '53194992'),
  (14, 'Makhahliso Malia', 'Malumeng', 'F', 55, 'H', '2 Acres', 'Cabbage,carrots,pepper,rape', 'Protected', '62550875'),
  (14, 'Malehloa Morojele', 'Makola', 'F', 29, 'H', '3 Acres', 'sethopo,cabbage,tomatoe,watermelon', 'Protected', '63627550'),
  (14, 'Malerato Marole', 'Ha Majara', 'F', 56, 'A', '3.6 Acres', 'Maize', 'Open Field', '59026645'),
  (14, 'Maleseli Mofana', 'Qopo', 'F', 42, 'A', '2 Acres', 'Maize, Beans', 'Open field', '50305483'),
  (14, 'Mampobane Mpobane', 'Mokhethoaneng', 'F', 67, 'A', '1.5 Acres', 'Maize', 'Open Field', '51733959'),
  (14, 'Marethabile Mafetoa', 'Ha Motsoene(Makola)', 'F', 50, 'A', '10 Acres', 'Maize, Beans, Sourghum', 'Open Field', '57406946'),
  (14, 'Maseboka khoae', 'Lovely rock', 'F', 62, 'H', '2 Acres', 'Cabbage,rape,tomatoe', 'Open field', '58592856'),
  (14, 'Mohau Lakeng', 'Sekamaneng', 'M', 68, 'H', '4 Acres', 'Cabbage,Rape,carrots,pepper', 'Open Field', '59000344'),
  (14, 'Mohau Moalosi', 'Ha Foso', 'M', 51, 'H', '30*30m', 'chillis,pepper,tomato,cabbage,green beans', 'Protected + Open', '58922689'),
  (14, 'Mohau Mohapi', 'Ha Makebe', 'M', 30, 'A', '3 Acres', 'Maize, Beans', 'Open Field', '59989736'),
  (14, 'Mokone Khoabane', 'Marabeng', 'M', 23, 'H', '6*30m,13*30m,0.5 Acres', 'Tomatomo,cabbage,Rape', 'Protected+ Open field', '51872119'),
  (14, 'Ntlatlapa Molebatsi', 'Ha Makebe', 'M', 40, 'A', '3 Acres', 'Maize', 'Open Field', '53433046'),
  (14, 'Ponts''o Ntlatlapo', 'Ha Makebe', 'M', 28, 'H', '3 Acres', 'Beetroot,cabbage,tomatoe,green papper,carrots,chillis', 'Open Field', '62696971/53163234'),
  (14, 'Selebalo Makebe', 'Ha Makebe', 'M', 32, 'A', '14 Acres', 'Maize, Beans, Sourghum,pumpkin', 'Open field', '62799412'),
  (14, 'Tankiso Mokhethi', 'Ha Molefi', 'M', 57, 'A', '2.1 Acres', 'Maize,beans', 'open Field', '58983970'),
  (14, 'Taoana Tsabalira', 'Koalabata', 'M', 60, 'H', '3 Acres', 'Cabbage,Rape,Spinach,pepper', 'Protected', '58563084'),
  (14, 'Thapelo Sebotsa', 'Makola', 'M', 42, 'H', '4 Acres', 'sethopo,cabbage,tomatoe,potatoe', 'Protected + Open', '58921725'),
  (15, 'Exinia Mojalehola', 'Kolojane', 'F', 28, 'H', '2.4 Acres', 'Cabbage, pepper,carrots', 'Open Field', '58362206'),
  (15, 'Fako Nani', 'Bela-Bela', 'M', 46, 'H', '1.4 Acres', 'Tomato, Cabbage', 'Open Field', '63802784'),
  (15, 'Frank Mahanetsa', 'Bela-Bela', 'M', 33, 'A', '3 Acres', 'Maize, Beans', 'Open Field', '57148060'),
  (15, 'Lefu Motlohi', 'Mafotholeng', 'M', 56, 'H', '1 Acre', 'Cabbage', 'Open Field', '57598399'),
  (15, 'Lehlohonolo Sello', 'Mokomahatsi', 'M', 32, 'A', '2.4 Acres', 'Maize', 'Open Field', '58354200'),
  (15, 'Letsoara Keele', 'Ha Lebentlele', 'M', 47, 'H', '2 Acres', 'Tomato, Cabbage', 'Protected', '58453759'),
  (15, 'Mabafokeng Raneileng', 'Baking', 'F', 54, 'A', '3.4 Acres', 'Maize, Beans, Sourghum', 'Open Field', '59365475'),
  (15, 'Mabokang Mokotjo', 'Mokomahatsi', 'F', 60, 'A', '1.5 Acres', 'Maize, Sourghum', 'Open Field', '58104487'),
  (15, 'Madingaan Borotho', null, 'F', 43, 'H', '1.24 Acres', 'Cabbage, pepper,carrots', 'Open Field', '58362206'),
  (15, 'Malefane Qekisi', 'Kolojane', 'M', 29, 'H', '2.7 Acres', 'Cabbage,rape,spinach', 'Open Field', '58480511'),
  (15, 'Malefane Qeko', 'Ha Seisa', 'M', 32, 'H', '1 Acre', 'Cabbage,rape,spinach', 'Open Field', '58480511'),
  (15, 'Malesisi Mokoaleli', 'Kolojane', 'F', 38, 'H', '1.7 Acres', 'Cabbage,rape', 'Open Field', '59798508'),
  (15, 'Marethabile Sekola', 'Bela-Bela', 'F', 36, 'H', '2.2+0.5 Acres', 'Potatoes, Cabbage,beetroot,carrots,tomatoe', 'Open Field', '58014140'),
  (15, 'Molai Tlali', 'Mafotholeng', 'M', 31, 'H', '1.4 Acres', 'Cabbage,Potatoes,Tomatoe', 'Open Field', '50557816'),
  (15, 'Mosoeu Nkhahle', 'Cx', 'M', 68, 'H', '1 Acre', 'Cabbage,rape,spinach', 'Protected', '58694599'),
  (15, 'Sekoala Makhabane', 'Bela-Bela', 'M', 35, 'H', '3 Acres', 'Cabbage,Potatoes,Tomatoe', 'Open Field', '56270380'),
  (15, 'Thabile Qopana', 'Ha Letsoela', 'F', 63, 'H', '1 Acre', 'Cabbage,rape,spinach', 'Open Field', '58789020'),
  (15, 'Tlholiso Moleli', 'Mokomahatsi', 'M', 33, 'H', '1 Acre', 'Potatoes', 'Open Field', '58580089'),
  (15, 'Ts''oloane Ntisa', 'Ha Ntisa', 'M', 52, 'A', '30 Acres', 'Maize, Beans', 'Open Field', '57877251'),
  (15, 'Tseliso Moremoholo', 'Kolojane', 'M', 32, 'H', '1.39 Acres', 'Cabbage,rape', 'Open Field', '57766375'),
  (16, 'John Nkonyana', 'Ha Seiso', 'M', 67, 'A', '100 Acres', 'Wheat,Potatoes,beans', 'Open Field', '58061994'),
  (16, 'Kanono Melato', 'Ha Matsa', 'M', 36, 'A', '1.7 Acres', 'Sourghum, Beans', 'Open Field', '56144211'),
  (16, 'Lehlohonolo Molato', 'Ha Matsa', 'M', 60, 'A', '4 Acres', 'Maize,Beans,Sourghum', 'Open Field', '57481083'),
  (16, 'Malehlohonolo Mokobocho', 'Ha Sehlabo', 'F', 32, 'A', '9.8 Acres', 'Maize,Beans,Sourghum', 'Open Field', '56880894'),
  (16, 'Malemisa Maphathe', 'Ha Matsa', 'F', 51, 'A', '2 Acres', 'Sourghum, Beans', 'Open Field', '63787993'),
  (16, 'Malipuo Nteka', 'Ha Seeiso', 'F', 61, 'A', '9.2 Acres', 'Maize,Beans,Sourghum', 'Open Field', '59490503'),
  (16, 'Mamatsoso Makubakube', 'Ha Matsa', 'F', 71, 'A', '1.9 Acres', 'Maize,Beans,Sourghum, Wheat', 'Open Field', '58586497'),
  (16, 'Mamonaheng Nkhabu', 'Ha Matsa', 'F', 52, 'A', '5.5 Acres', 'Maize,Beans,Sourghum', 'Open Field', '59420530'),
  (16, 'Manthabiseng Maphate', 'Ha Matsa', 'F', 51, 'A', '3 Acres', 'Maize,Beans,Sourghum', 'Open Field', null),
  (16, 'Marethabile Mokitimi', 'Ha Seeiso', 'F', 66, 'A', '21 Acres', 'Maize,Beans', 'Open Field', '58591432'),
  (16, 'Mathabo Makoatle', 'Ha Seeiso', 'F', 45, 'A', '1.5 Acres', 'Sourghum, Beans', 'Open Field', '58606294'),
  (16, 'Matieho Rasebonoang', 'Ha Seiso', 'F', 59, 'A', '8 Acres', 'Maize,Beans,Sourghum', 'Open Field', '58942229'),
  (16, 'Paballo Makoatle', 'Ha Matsa', 'M', 57, 'A', '1.3 Acres', 'Sourghum, Beans', 'Open Field', '57866686'),
  (16, 'Paul Motlaopa', 'Ha Mokhothu', 'M', 51, 'A', '5 Acres', 'Maize', 'Open Field', '50214528'),
  (16, 'Raphosholi Maphate', 'Ha Matsa', 'M', 43, 'A', '40 Acres', 'Maize,Beans,Sourghum', 'Open Field', '58827686'),
  (16, 'Thabo Melato', 'Ha Seeiso', 'M', 49, 'A', '3.4 Acres', 'Maize, Beans,Sourghum', 'Open Field', '56695287'),
  (16, 'Thabo Ntekeloa', 'Ha Thamae', 'M', 68, 'A', '150 Acres', 'Maize,Beans,Sourghum', 'Open Field', '56563250'),
  (16, 'Thapelo Polile', 'Ha Matsa', 'M', 27, 'A', '4.3 Acres', 'Beans', 'Open Field', '57479566'),
  (16, 'Tseliso Makepe', 'Ha Seiso', 'M', 79, 'A', '50 Acres', 'Maize,Beans,Sourghum', 'Open Field', '56238673'),
  (16, 'Tsietsi Mokitimi', 'Ha Seeiso', 'M', 59, 'A', '100 Acres', 'Wheat,beans', 'Open Field', '62002688'),
  (17, 'Abiel Nkhabu', 'Ha Nkhabu', 'M', 50, 'A', '3 Acres', 'Maize,Beans, Sourghum', 'Open Field', '57888843'),
  (17, 'Chabeli Sesenyi', 'Ha Mohlalefi', 'M', 56, 'A', '7.1 Acres', 'Maize,Beans, Sourghum', 'Open Field', '51633403'),
  (17, 'Khola Moiloa', 'Ha Mphaololi', 'M', 56, 'A', '5 Acres', 'Maize, Beans', 'Open Field', '56304076'),
  (17, 'Lekhotla Matima', 'Ha Mohale', 'M', 40, 'A', '3 Acres', 'Beans', 'Open Field', '59130441'),
  (17, 'Lentsoe Seipobi', 'Ha Majake', 'M', 65, 'A', '8.5 Acres', 'Maize,Beans', 'Open Field', '56218509'),
  (17, 'Mabokang Semuli', 'Ha Semuli', 'F', 52, 'A', '7 Acres', 'Maize, Beans', 'Open Field', '50401432'),
  (17, 'Maitumeleng Phiri', 'Ha Ratsoeu', 'F', 67, 'A', '3 Acres', 'Maize,sourghum, Beans', 'Open Field', '59792804'),
  (17, 'Maitumeleng Tjamela', 'Ha Mohlalefi', 'F', 64, 'A', '3 Acres', 'Maize, Beans', 'Open Field', '58459888'),
  (17, 'Maleemisa Sesinyi', 'Ha Mofo', 'F', 72, 'A', '4 Acres', 'Maize, Beans', 'Open Field', '56837700'),
  (17, 'Mamahlehle Mothoalo', 'Ha Rabeleng', 'F', 71, 'A', '1.7 Acres', 'Maize, Beans', 'Open Field', '51715058'),
  (17, 'Mameshaka Nkhabu', 'Ha Nkhabu', 'F', 58, 'A', '6.5 Acres', 'Maize, Sourghum', 'Open Field', '50512034'),
  (17, 'Mamosiuoa Mantsi', 'Matlakauoeng', 'F', 63, 'A', '4.5 Acres', 'Maize,Beans', 'Open Field', '59701612'),
  (17, 'Maneo Ratefane', 'Ha Mohlalefi', 'F', 69, 'A', '1.3 Acres', 'Maize', 'Open Field', '57168101'),
  (17, 'Mapaballo Mahao', 'Ha Rabeleng', 'F', 53, 'A', '3.5 Acres', 'Maize, Beans', 'Open Field', '53010520'),
  (17, 'Mapaseka Sekantsi', 'Ha Rabeleng', 'F', 63, 'A', '3.6 Acres', 'Maize', 'Open Field', '50006283'),
  (17, 'Maphakiso Letsie', 'Matlakauoeng', 'F', 62, 'A', '4.6 Acres', 'Maize,sourghum', 'Open Field', '57710612'),
  (17, 'Mathapelo Sello', 'Ha Ntsie', 'F', 39, 'A', '7.2 Acres', 'Maize,sourghum', 'Open Field', '56427939'),
  (17, 'Matumelo Sebatane', 'Ha Mohlalefi', 'F', 73, 'A', '7 Acres', 'Maize, Beans', 'Open Field', '58170171'),
  (17, 'Motloheloa Mohapi', 'Ha Ntsie', 'M', 68, 'A', '8 Acres', 'Maize', 'Open Field', '58033781'),
  (17, 'Richard Mjezu', 'Ha Mohlalefi', 'M', 67, 'H', '3.5 Acres', 'Cabbage,tomato,Pepper', 'Protected + Open', '58091651'),
  (18, 'Khoto Ramokoatsi', 'Ha Ramokoatsi', 'M', 49, 'A', '3 Acres', 'Maize', 'Open field', '59542579'),
  (18, 'Lephoi Lebea', 'Ha Makopela', 'M', 58, 'A', '10.6 Acres', 'Maize, Sourghum', 'Open field', '59896444'),
  (18, 'Mahlompho Mashobane', 'Ha Ramokoatsi', 'F', 50, 'A', '1.5 Acres', 'Maize, Beans', 'Open field', '57772224'),
  (18, 'Makhau Ramokoatsi', 'Ha Ramokoatsi', 'F', 57, 'H', '1 Acre', 'Cabbage,Tomatoe,Potatoes', 'Open field', '57287017'),
  (18, 'Malefa ramokoatsi', 'Ha Ramokoatsi', 'F', 57, 'A', '1.5 Acres', 'Maize, Sourghum', 'Open field', '58947406'),
  (18, 'Malikhatsa Lebea', 'Ha Makopela', 'F', 57, 'A', '2.7 Acres', 'Maize, Wheat', 'Open field', '58472568'),
  (18, 'Malintle Leeto', 'Ha Ntlhakeng', 'F', 34, 'A', '5 Acres', 'Maize, Sourghum', 'Open field', '57373852'),
  (18, 'Manyakallo Mafatle', 'Ha Ramokoatsi', 'F', 60, 'A', '1.5 Acres', 'Maize, Sourghum', 'Open field', '56640666'),
  (18, 'Mapaseka Nthakeng', 'Ha Ntlhakeng', 'F', 73, 'H', '30*30m', 'Cabbage, Tomatoe, Beetroot', 'Protected', '58609279'),
  (18, 'Marelebohile Mafatle', 'Ha Ramokoatsi', 'F', 43, 'A', '6 Acres', 'Maize, Beans', 'Open field', '57413280'),
  (18, 'Masebolelo Ramokoatsi', 'Ha Ramokoatsi', 'F', 58, 'A', '3.3 Acres', 'Maize, Sourghum, Beans', 'Open field', '59218276'),
  (18, 'Masenate Motene', 'Matlholeng', 'F', 57, 'H', '40*20m', 'Cabbage,carrots,rape', 'Open field', '63738639'),
  (18, 'Mathabang Ramokoatsi', 'Ha Ramokoatsi', 'F', 46, 'H', '0.5 Acres', 'Cabbage, Rape', 'Open field', '59599032'),
  (18, 'Mathato Liau', 'Thaba- tsoeu', 'F', 36, 'A', '7.1 Acres', 'Maize, Sourghum,peas,beans,wheat', 'Open field', '59654051'),
  (18, 'Matsoanelo Mphaka', 'Ha Ramokoatsi', 'F', 39, 'A', '2.3 Acres', 'Maize, Sourghum', 'Open field', '57544502'),
  (18, 'Moeketsi Mafatle', 'Ha Ramokoatsi', 'M', 37, 'H', '30*30m', 'Cabbage,rape,potatoes', 'Open field', '57274414'),
  (18, 'Moliehi Mofa', 'Ha Ramokoatsi', 'F', 61, 'H', '30*20m', 'Tomato, Green Pepper', 'Protected', '57161038'),
  (18, 'Motlatsi Khonthu', 'Ha Ramokoatsi', 'M', 40, 'A', '3 Acres', 'Maize, Beans, Pumpkin', 'Open field', '58018683'),
  (18, 'Phetetsi Seitlheko', 'Ha Ramokoatsi', 'M', 23, 'A', '2 Acres', 'Maize', 'Open field', '58828585'),
  (18, 'Potso Mafatle', 'Ha Ramokoatsi', 'M', 40, 'A', '2 Acres', 'Maize, Sourghum', 'Open field', '58550209'),
  (18, 'Thabiso Mohlapisi', 'Ha Ramokoatsi', 'M', 47, 'H', '10*5m', 'Cabbage, Rape', 'Open field', '57834547'),
  (18, 'khomopeli Ramokoatsi', 'Ha Ramokoatsi', 'M', 70, 'A', '2.5 Acres', 'Maize,Peas', 'Open field', '58820071');

-- match on site + name ignoring case, spacing and punctuation
create index on incoming (site_id, lower(regexp_replace(name, '[^a-zA-Z]', '', 'g')));

-- 3. update everyone already on file -----------------------------------------
update fs_farmers f set
  name       = i.name,          -- normalises spacing/punctuation to the workbook
  village    = i.village,
  gender     = i.gender,
  age        = i.age,
  production = i.production,
  field_size = i.field_size,
  crops      = i.crops,
  system     = i.system,
  phone      = i.phone,
  active     = true
from incoming i
where f.source = 'profiled'
  and f.site_id = i.site_id
  and lower(regexp_replace(f.name, '[^a-zA-Z]', '', 'g'))
    = lower(regexp_replace(i.name, '[^a-zA-Z]', '', 'g'));

-- 4. add the farmers who are new ---------------------------------------------
insert into fs_farmers (site_id, name, village, gender, age, production,
                        field_size, crops, system, phone, source)
select i.site_id, i.name, i.village, i.gender, i.age, i.production,
       i.field_size, i.crops, i.system, i.phone, 'profiled'
from incoming i
where not exists (
  select 1 from fs_farmers f
  where f.source = 'profiled' and f.site_id = i.site_id
    and lower(regexp_replace(f.name, '[^a-zA-Z]', '', 'g'))
      = lower(regexp_replace(i.name, '[^a-zA-Z]', '', 'g')));

-- 5. retire the farmers the workbook dropped (history preserved) --------------
update fs_farmers f set active = false
where f.source = 'profiled' and f.active
  and not exists (
    select 1 from incoming i
    where i.site_id = f.site_id
      and lower(regexp_replace(i.name, '[^a-zA-Z]', '', 'g'))
        = lower(regexp_replace(f.name, '[^a-zA-Z]', '', 'g')));

-- 6. check before committing --------------------------------------------------
--    expected: active_profiled = 344, retired names listed, visits still linked
select
  (select count(*) from fs_farmers where source = 'profiled' and active)      as active_profiled,
  (select count(*) from fs_farmers where source = 'profiled' and not active)  as retired,
  (select count(*) from fs_farmers where source = 'fs_registered')            as fs_registered,
  (select count(*) from fs_visits where farmer_id is not null)                as visits_still_linked;

select s.sub_area, f.name, f.phone
from fs_farmers f join fs_sites s on s.id = f.site_id
where f.source = 'profiled' and not f.active
order by s.sub_area, f.name;

-- retired farmers must not reach the FS picker. Expect 'filters active' — if it
-- says CHECK MANUALLY, fs_bootstrap needs "and f.active" on its farmers query.
select case when pg_get_functiondef(p.oid) ~* 'fs_farmers[^;]*active'
            then 'fs_bootstrap filters active'
            else 'CHECK MANUALLY: fs_bootstrap may still return retired farmers'
       end as bootstrap_check
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'fs_bootstrap';

-- data quality to resolve with the field team (imported as-is, not blocked):
-- two phone numbers are each shared by two farmers, and one name appears at two
-- different resource centres.
select f.phone, count(*) as farmers,
       string_agg(s.sub_area || ': ' || f.name, ' | ') as who
from fs_farmers f join fs_sites s on s.id = f.site_id
where f.source = 'profiled' and f.active and f.phone is not null
group by f.phone having count(*) > 1;

select f.name, string_agg(distinct s.sub_area, ', ') as sub_areas
from fs_farmers f join fs_sites s on s.id = f.site_id
where f.source = 'profiled' and f.active
group by f.name having count(distinct f.site_id) > 1;

commit;
