// FS Field Monitoring — seed reference data (offline fallback).
// The live copy comes from Supabase via fs_bootstrap and is cached after login;
// this file only backs the UI when no cached bootstrap exists yet.
// 17 resource centres -> 18 GPS-tagged sub-areas (Peka RC has 2 sub-areas).
window.FSM_SEED = {
  sites: [
    { id: 1,  district: 'Maseru',        rc: 'Rothe',           sub_area: 'Mahuu',       zone: 'Lowlands',  lat: -29.519759, lon: 27.422734, farmers: 19, is_validation_site: false },
    { id: 2,  district: 'Maseru',        rc: 'Ntsi',            sub_area: 'Matela',      zone: 'Lowlands',  lat: -29.378881, lon: 27.773753, farmers: 23, is_validation_site: false },
    { id: 3,  district: 'Maseru',        rc: 'Marakabei',       sub_area: 'Likalaneng',  zone: 'Mountains', lat: -29.476349, lon: 28.050857, farmers: 20, is_validation_site: false },
    { id: 4,  district: 'Maseru',        rc: 'Morija',          sub_area: 'Morija',      zone: 'Lowlands',  lat: -29.622674, lon: 27.500640, farmers: 20, is_validation_site: true  },
    { id: 5,  district: 'Maseru',        rc: 'Ramabanta',       sub_area: 'Nyakosoba',   zone: 'Foothills', lat: -29.524466, lon: 27.773905, farmers: 20, is_validation_site: false },
    { id: 6,  district: "Mohale's Hoek", rc: 'Makhaleng',       sub_area: 'Makhaleng',   zone: 'Lowlands',  lat: -30.160589, lon: 27.466777, farmers: 20, is_validation_site: false },
    { id: 7,  district: "Mohale's Hoek", rc: 'Mekaling',        sub_area: 'Mekaling',    zone: 'Foothills', lat: -30.294823, lon: 27.502955, farmers: 20, is_validation_site: false },
    { id: 8,  district: 'Leribe',        rc: 'Peka',            sub_area: 'Peka',        zone: 'Lowlands',  lat: -28.968918, lon: 27.761519, farmers: 10, is_validation_site: false },
    { id: 9,  district: 'Leribe',        rc: 'Peka',            sub_area: 'Tabola',      zone: 'Lowlands',  lat: -28.950056, lon: 27.818802, farmers: 10, is_validation_site: false },
    { id: 10, district: 'Leribe',        rc: 'Khabo',           sub_area: 'Tsehlanyane', zone: 'Foothills', lat: -28.837927, lon: 28.223056, farmers: 20, is_validation_site: false },
    { id: 11, district: 'Leribe',        rc: 'Mahobong',        sub_area: 'Seetsa',      zone: 'Foothills', lat: -28.936543, lon: 28.237824, farmers: 20, is_validation_site: false },
    { id: 12, district: 'Berea',         rc: 'Pilot',           sub_area: 'Pilot',       zone: 'Foothills', lat: -29.212233, lon: 27.862336, farmers: 20, is_validation_site: false },
    { id: 13, district: 'Berea',         rc: 'Sefikeng',        sub_area: 'Thuoathe',    zone: 'Lowlands',  lat: -29.326586, lon: 27.576908, farmers: 20, is_validation_site: true  },
    { id: 14, district: 'Berea',         rc: 'Maqhaka',         sub_area: 'Maqhaka',     zone: 'Lowlands',  lat: -29.246008, lon: 27.604973, farmers: 20, is_validation_site: true  },
    { id: 15, district: 'Berea',         rc: 'Corner Exchange', sub_area: 'CX',          zone: 'Foothills', lat: -28.973164, lon: 27.975466, farmers: 20, is_validation_site: false },
    { id: 16, district: 'Mafeteng',      rc: 'Matelile',        sub_area: 'Matelile',    zone: 'Foothills', lat: -29.819832, lon: 27.515345, farmers: 20, is_validation_site: false },
    { id: 17, district: 'Mafeteng',      rc: 'Kolo',            sub_area: 'Kolo',        zone: 'Foothills', lat: -29.607740, lon: 27.325150, farmers: 20, is_validation_site: true  },
    { id: 18, district: 'Mafeteng',      rc: 'Ramokoatsi',      sub_area: 'Ramokoatsi',  zone: 'Lowlands',  lat: -29.748099, lon: 27.346324, farmers: 22, is_validation_site: false }
  ],
  // 3 validation farms per flagged site (id = site_id * 10 + n)
  farms: [4, 13, 14, 17].flatMap(function (siteId) {
    return [1, 2, 3].map(function (n) {
      return { id: siteId * 10 + n, site_id: siteId, label: 'Farm ' + n };
    });
  })
};
