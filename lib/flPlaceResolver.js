// lib/flPlaceResolver.js
// Florida place name → ZIP resolver
// All deterministic — no API calls, no LLM

// Primary ZIP for each FL county (67 counties)
const COUNTY_PRIMARY_ZIP = {
  'alachua': '32601', 'baker': '32063', 'bay': '32401', 'bradford': '32091',
  'brevard': '32901', 'broward': '33301', 'calhoun': '32421', 'charlotte': '33950',
  'citrus': '34428', 'clay': '32073', 'collier': '34102', 'columbia': '32024',
  'desoto': '34266', 'dixie': '32628', 'duval': '32202', 'escambia': '32501',
  'flagler': '32137', 'franklin': '32320', 'gadsden': '32301', 'gilchrist': '32619',
  'glades': '33440', 'gulf': '32456', 'hamilton': '32052', 'hardee': '33830',
  'hendry': '33440', 'hernando': '34601', 'highlands': '33870', 'hillsborough': '33601',
  'holmes': '32425', 'indian river': '32960', 'jackson': '32401', 'jefferson': '32344',
  'lafayette': '32066', 'lake': '34748', 'lee': '33901', 'leon': '32301',
  'levy': '32626', 'liberty': '32321', 'madison': '32340', 'manatee': '34205',
  'marion': '34470', 'martin': '34994', 'miami-dade': '33101', 'monroe': '33040',
  'nassau': '32034', 'okaloosa': '32501', 'okeechobee': '34972', 'orange': '32801',
  'osceola': '34741', 'palm beach': '33401', 'pasco': '33525', 'pinellas': '33701',
  'polk': '33801', 'putnam': '32177', 'santa rosa': '32570', 'sarasota': '34230',
  'seminole': '32771', 'st. johns': '32084', 'st. lucie': '34950', 'sumter': '33585',
  'suwannee': '32060', 'taylor': '32347', 'union': '32083', 'volusia': '32114',
  'wakulla': '32327', 'walton': '32459', 'washington': '32428',
};

// County name variations → canonical key
const COUNTY_ALIASES = {
  'st johns': 'st. johns', 'st. johns county': 'st. johns', 'stjohns': 'st. johns',
  'duval county': 'duval', 'miami dade': 'miami-dade', 'miami-dade county': 'miami-dade',
  'palm beach county': 'palm beach', 'st lucie': 'st. lucie', 'st. lucie county': 'st. lucie',
  'santa rosa county': 'santa rosa',
};

// County → ZIP array (for ranked analysis)
const COUNTY_ZIPS = {
  'st. johns': ['32082','32081','32250','32266','32259','32092','32084','32095','32080','32086'],
  'duval': ['32202','32204','32205','32206','32207','32208','32209','32210','32211','32216','32217','32218','32219','32220','32221','32222','32223','32224','32225','32226','32233','32244','32246','32250','32254','32256','32257','32258','32266'],
  'clay': ['32043','32065','32068','32073','32656'],
  'nassau': ['32034','32046','32097'],
  'flagler': ['32110','32136','32137'],
  'putnam': ['32148','32177','32193'],
  'leon': ['32301','32303','32304','32305','32308','32309','32310','32311','32312'],
  'hillsborough': ['33601','33602','33603','33604','33605','33606','33607','33609','33610','33611','33612','33613','33614','33615','33616','33617','33618','33619','33620','33621','33624','33625','33626','33629','33634','33635','33637'],
  'pinellas': ['33701','33702','33703','33704','33705','33706','33707','33708','33709','33710','33711','33712','33713','33714','33715','33716'],
  'orange': ['32801','32803','32804','32805','32806','32807','32808','32809','32810','32811','32812','32814','32817','32818','32819','32820','32821','32822','32824','32825','32826','32827','32828','32829','32831','32832','32833','32835','32836','32837','32839'],
  'broward': ['33301','33304','33305','33306','33308','33309','33310','33311','33312','33314','33315','33316','33317','33319','33322','33324','33325','33326','33328','33330','33331','33332','33334','33388'],
  'miami-dade': ['33101','33109','33122','33125','33126','33127','33128','33129','33130','33131','33132','33133','33134','33135','33136','33137','33138','33139','33140','33141','33142','33143','33144','33145','33146','33147','33149','33150','33154','33155','33156','33157','33158','33160','33161','33162','33165','33166','33167','33168','33169','33170','33172','33173','33174','33175','33176','33177','33178','33179','33180','33181','33182','33183','33184','33185','33186','33187','33189','33190','33193','33194','33196'],
  'palm beach': ['33401','33403','33404','33405','33406','33407','33408','33409','33410','33411','33412','33413','33414','33415','33417','33418','33426','33428','33430','33431','33432','33433','33434','33435','33436','33437','33438','33440','33444','33445','33446','33449','33458','33460','33461','33462','33463','33467','33469','33470','33472','33473','33476','33477','33478','33480','33483','33484','33486','33487','33493','33496','33498'],
  'sarasota': ['34230','34231','34232','34233','34234','34235','34236','34237','34238','34239','34241','34242','34275','34285','34286','34287','34288','34289','34291','34292','34293'],
  'collier': ['34102','34103','34104','34105','34108','34109','34110','34112','34113','34114','34116','34117','34119','34120'],
  'lee': ['33901','33907','33908','33909','33912','33913','33914','33919','33928','33931','33936','33967','33971','33972','33974','33976','34134','34135'],
  'volusia': ['32114','32117','32118','32119','32124','32127','32128','32129','32130','32132','32141','32168','32174','32176','32180','32190'],
  'brevard': ['32901','32903','32904','32905','32907','32908','32909','32920','32922','32925','32926','32927','32931','32934','32935','32937','32940','32948','32949','32950','32951','32952','32953','32955','32976'],
  'seminole': ['32701','32703','32707','32708','32714','32730','32732','32746','32750','32765','32771','32773','32779'],
  'manatee': ['34201','34202','34203','34205','34208','34209','34210','34211','34212','34215','34217','34219','34221','34222'],
  'marion': ['34470','34471','34472','34473','34474','34475','34476','34479','34480','34481','34482','34488','34491'],
  'pasco': ['33523','33525','33526','33527','33534','33540','33541','33542','33543','33544','33545','33548','33549','33556','33558','33559','33576'],
  'hernando': ['34601','34602','34604','34606','34607','34608','34609','34610','34613','34614'],
  'lake': ['32702','32726','32735','32736','32746','32757','32767','32778','34711','34714','34715','34731','34736','34737','34748','34753','34756','34762','34788','34797'],
  'polk': ['33801','33803','33805','33809','33810','33811','33812','33813','33815','33823','33827','33830','33837','33838','33839','33840','33841','33843','33844','33849','33850','33851','33853','33857','33860','33868','33880','33881','33884'],
  'escambia': ['32501','32503','32504','32505','32506','32507','32508','32511','32514','32526','32533','32534','32535','32577'],
  'okaloosa': ['32531','32536','32537','32539','32540','32541','32542','32544','32547','32548','32564','32567','32569','32578','32579','32580'],
};

// Major FL cities/neighborhoods → ZIP
const CITY_ZIP = {
  // St. Johns County
  'ponte vedra': '32082', 'ponte vedra beach': '32082', 'nocatee': '32081',
  'jacksonville beach': '32250', 'neptune beach': '32266', 'atlantic beach': '32233',
  'st. johns': '32259', 'saint johns': '32259', 'world golf village': '32092',
  'st. augustine': '32084', 'saint augustine': '32084', 'fernandina beach': '32034',
  'fernandina': '32034', 'amelia island': '32034', 'yulee': '32097',
  // Jacksonville / Duval
  'jacksonville': '32207', 'jax': '32207', 'downtown jacksonville': '32202',
  'riverside': '32204', 'avondale': '32205', 'san marco': '32207',
  'southside': '32256', 'mandarin': '32257', 'baymeadows': '32256',
  'arlington': '32211', 'northside': '32218', 'westside': '32210',
  'san jose': '32257', 'deerwood': '32256', 'town center': '32246',
  // Miami / South Florida
  'miami': '33101', 'miami beach': '33139', 'south beach': '33139',
  'brickell': '33131', 'wynwood': '33127', 'little havana': '33135',
  'coconut grove': '33133', 'coral gables': '33134', 'miami gardens': '33056',
  'hialeah': '33010', 'doral': '33178', 'kendall': '33176',
  'homestead': '33030', 'miami lakes': '33014', 'aventura': '33160',
  'miami shores': '33138', 'north miami': '33161', 'opa locka': '33054',
  'west miami': '33144', 'cutler bay': '33189', 'palmetto bay': '33157',
  'pinecrest': '33156',
  // Broward
  'fort lauderdale': '33301', 'ft lauderdale': '33301', 'hollywood': '33020',
  'pembroke pines': '33024', 'miramar': '33025', 'sunrise': '33322',
  'plantation': '33317', 'coral springs': '33065', 'pompano beach': '33060',
  'deerfield beach': '33441', 'weston': '33326', 'davie': '33314',
  'hallandale beach': '33009', 'lauderhill': '33313', 'tamarac': '33319',
  'margate': '33063', 'coconut creek': '33063',
  // Palm Beach
  'west palm beach': '33401', 'boca raton': '33431', 'delray beach': '33444',
  'boynton beach': '33435', 'lake worth': '33460', 'wellington': '33414',
  'palm beach gardens': '33410', 'jupiter': '33458', 'palm city': '33990',
  'stuart': '34994', 'port st lucie': '34950', 'port saint lucie': '34950',
  'fort pierce': '34950', 'vero beach': '32960',
  // Tampa Bay
  'tampa': '33601', 'st. pete': '33701', 'saint pete': '33701',
  'st. petersburg': '33701', 'saint petersburg': '33701',
  'clearwater': '33755', 'brandon': '33511', 'riverview': '33578',
  'wesley chapel': '33543', 'land o lakes': '34639', 'lutz': '33558',
  'new port richey': '34652', 'spring hill': '34609', 'brooksville': '34601',
  'dunedin': '34698', 'safety harbor': '34695', 'tarpon springs': '34689',
  'palm harbor': '34683', 'seminole': '33772', 'largo': '33770',
  'pinellas park': '33781', 'kennesaw': '33709',
  // Orlando / Central FL
  'orlando': '32801', 'kissimmee': '34741', 'sanford': '32771',
  'altamonte springs': '32701', 'casselberry': '32707', 'oviedo': '32765',
  'winter park': '32789', 'maitland': '32751', 'apopka': '32703',
  'clermont': '34711', 'leesburg': '34748', 'the villages': '32162',
  'ocala': '34470', 'gainesville': '32601', 'daytona beach': '32114',
  'new smyrna beach': '32168', 'deland': '32720', 'deltona': '32725',
  'port orange': '32127', 'ormond beach': '32174',
  // Space Coast / Treasure Coast
  'melbourne': '32901', 'cocoa beach': '32931', 'titusville': '32796',
  'cape canaveral': '32920', 'merritt island': '32952',
  'palm bay': '32905',
  // Southwest FL
  'naples': '34102', 'marco island': '34145', 'cape coral': '33990',
  'fort myers': '33901', 'ft myers': '33901', 'bonita springs': '34135',
  'estero': '33928', 'lehigh acres': '33936', 'sarasota': '34230',
  'bradenton': '34205', 'venice': '34285', 'north port': '34286',
  'englewood': '34223', 'punta gorda': '33950', 'port charlotte': '33948',
  // Panhandle / Northwest
  'pensacola': '32501', 'destin': '32541', 'fort walton beach': '32548',
  'ft walton beach': '32548', 'niceville': '32578', 'crestview': '32536',
  'panama city': '32401', 'panama city beach': '32407', 'tallahassee': '32301',
  // Other
  'key west': '33040', 'marathon': '33050', 'key largo': '33037',
  'lake city': '32024', 'live oak': '32060', 'palatka': '32177',
};

/**
 * Resolve a question to { zip, isCounty, countyKey, countyZips }
 * isCounty=true means the question spans multiple ZIPs and should use county scoring
 */
function resolvePlace(question) {
  const q = String(question || '').toLowerCase();

  // Check for explicit 5-digit ZIP first
  const zipMatch = q.match(/\b(\d{5})\b/);
  if (zipMatch) return { zip: zipMatch[1], isCounty: false, countyKey: null, countyZips: null };

  // Check county names
  for (const [alias, canonical] of Object.entries(COUNTY_ALIASES)) {
    if (q.includes(alias)) {
      return {
        zip: COUNTY_PRIMARY_ZIP[canonical] || '32082',
        isCounty: true,
        countyKey: canonical,
        countyZips: COUNTY_ZIPS[canonical] || null
      };
    }
  }
  for (const [county, zip] of Object.entries(COUNTY_PRIMARY_ZIP)) {
    if (q.includes(county)) {
      return {
        zip,
        isCounty: true,
        countyKey: county,
        countyZips: COUNTY_ZIPS[county] || null
      };
    }
  }

  // Check city names (longer names first to avoid partial matches)
  const cityEntries = Object.entries(CITY_ZIP).sort((a, b) => b[0].length - a[0].length);
  for (const [city, zip] of cityEntries) {
    if (q.includes(city)) return { zip, isCounty: false, countyKey: null, countyZips: null };
  }

  // Default
  return { zip: '32082', isCounty: false, countyKey: null, countyZips: null };
}

module.exports = { resolvePlace, COUNTY_ZIPS, COUNTY_PRIMARY_ZIP };
