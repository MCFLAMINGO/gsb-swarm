-- Migration 037: add sunbiz_city to fl_place_index
-- Maps each place entry to its USPS/SunBiz principal_city value
-- so sunbiz_raw lookups can match without hardcoded JS maps.

ALTER TABLE fl_place_index ADD COLUMN IF NOT EXISTS sunbiz_city TEXT;

-- St. Johns County
UPDATE fl_place_index SET sunbiz_city = 'PONTE VEDRA BEACH'  WHERE name_normalized = 'ponte vedra beach';
UPDATE fl_place_index SET sunbiz_city = 'PONTE VEDRA BEACH'  WHERE name_normalized = 'ponte vedra';
UPDATE fl_place_index SET sunbiz_city = 'PONTE VEDRA'        WHERE name_normalized = 'ponte vedra' AND sunbiz_city IS NULL;
UPDATE fl_place_index SET sunbiz_city = 'PONTE VEDRA BEACH'  WHERE county_key = 'st. johns' AND primary_zip = '32082';
UPDATE fl_place_index SET sunbiz_city = 'NOCATEE'            WHERE name_normalized = 'nocatee';
UPDATE fl_place_index SET sunbiz_city = 'SAINT JOHNS'        WHERE name_normalized IN ('st. johns','saint johns') AND county_key = 'st. johns';
UPDATE fl_place_index SET sunbiz_city = 'SAINT AUGUSTINE'    WHERE name_normalized IN ('st. augustine','saint augustine');
UPDATE fl_place_index SET sunbiz_city = 'WORLD GOLF VILLAGE' WHERE name_normalized = 'world golf village';

-- Duval County — all neighborhoods → JACKSONVILLE (USPS city for most Duval ZIPs)
UPDATE fl_place_index SET sunbiz_city = 'JACKSONVILLE'
  WHERE county_key = 'duval'
    AND name_normalized IN (
      'jacksonville','jax','downtown jacksonville','riverside','avondale',
      'san marco','mandarin','baymeadows','arlington','northside','westside',
      'san jose','deerwood','town center','jacksonville duval'
    );

-- Duval beach cities (distinct USPS cities)
UPDATE fl_place_index SET sunbiz_city = 'JACKSONVILLE BEACH' WHERE name_normalized = 'jacksonville beach';
UPDATE fl_place_index SET sunbiz_city = 'NEPTUNE BEACH'      WHERE name_normalized = 'neptune beach';
UPDATE fl_place_index SET sunbiz_city = 'ATLANTIC BEACH'     WHERE name_normalized = 'atlantic beach';

-- Duval — Southside/Baymeadows are actually Jacksonville USPS
UPDATE fl_place_index SET sunbiz_city = 'JACKSONVILLE'
  WHERE county_key = 'duval' AND sunbiz_city IS NULL;

-- Nassau
UPDATE fl_place_index SET sunbiz_city = 'FERNANDINA BEACH'   WHERE name_normalized IN ('fernandina beach','fernandina','amelia island');
UPDATE fl_place_index SET sunbiz_city = 'YULEE'              WHERE name_normalized = 'yulee';

-- Miami-Dade
UPDATE fl_place_index SET sunbiz_city = 'MIAMI'              WHERE name_normalized IN ('miami','brickell','wynwood','little havana','west miami','miami shores') AND county_key = 'miami-dade';
UPDATE fl_place_index SET sunbiz_city = 'MIAMI BEACH'        WHERE name_normalized IN ('miami beach','south beach');
UPDATE fl_place_index SET sunbiz_city = 'CORAL GABLES'       WHERE name_normalized = 'coral gables';
UPDATE fl_place_index SET sunbiz_city = 'HIALEAH'            WHERE name_normalized = 'hialeah';
UPDATE fl_place_index SET sunbiz_city = 'AVENTURA'           WHERE name_normalized = 'aventura';
UPDATE fl_place_index SET sunbiz_city = 'HOMESTEAD'          WHERE name_normalized = 'homestead';
UPDATE fl_place_index SET sunbiz_city = 'NORTH MIAMI'        WHERE name_normalized = 'north miami';
UPDATE fl_place_index SET sunbiz_city = 'DORAL'              WHERE name_normalized = 'doral';
UPDATE fl_place_index SET sunbiz_city = 'KENDALL'            WHERE name_normalized = 'kendall';

-- Broward
UPDATE fl_place_index SET sunbiz_city = 'FORT LAUDERDALE'    WHERE name_normalized IN ('fort lauderdale','ft lauderdale');
UPDATE fl_place_index SET sunbiz_city = 'HOLLYWOOD'          WHERE name_normalized = 'hollywood' AND county_key = 'broward';
UPDATE fl_place_index SET sunbiz_city = 'PEMBROKE PINES'     WHERE name_normalized = 'pembroke pines';
UPDATE fl_place_index SET sunbiz_city = 'MIRAMAR'            WHERE name_normalized = 'miramar';
UPDATE fl_place_index SET sunbiz_city = 'SUNRISE'            WHERE name_normalized = 'sunrise';
UPDATE fl_place_index SET sunbiz_city = 'CORAL SPRINGS'      WHERE name_normalized = 'coral springs';
UPDATE fl_place_index SET sunbiz_city = 'POMPANO BEACH'      WHERE name_normalized = 'pompano beach';
UPDATE fl_place_index SET sunbiz_city = 'WESTON'             WHERE name_normalized = 'weston';
UPDATE fl_place_index SET sunbiz_city = 'DAVIE'              WHERE name_normalized = 'davie';
UPDATE fl_place_index SET sunbiz_city = 'PLANTATION'         WHERE name_normalized = 'plantation';

-- Palm Beach
UPDATE fl_place_index SET sunbiz_city = 'WEST PALM BEACH'    WHERE name_normalized = 'west palm beach';
UPDATE fl_place_index SET sunbiz_city = 'BOCA RATON'         WHERE name_normalized = 'boca raton';
UPDATE fl_place_index SET sunbiz_city = 'DELRAY BEACH'       WHERE name_normalized = 'delray beach';
UPDATE fl_place_index SET sunbiz_city = 'BOYNTON BEACH'      WHERE name_normalized = 'boynton beach';
UPDATE fl_place_index SET sunbiz_city = 'PALM BEACH GARDENS' WHERE name_normalized = 'palm beach gardens';
UPDATE fl_place_index SET sunbiz_city = 'JUPITER'            WHERE name_normalized = 'jupiter';
UPDATE fl_place_index SET sunbiz_city = 'WELLINGTON'         WHERE name_normalized = 'wellington';

-- Tampa Bay
UPDATE fl_place_index SET sunbiz_city = 'TAMPA'              WHERE name_normalized = 'tampa';
UPDATE fl_place_index SET sunbiz_city = 'SAINT PETERSBURG'   WHERE name_normalized IN ('st. pete','saint pete','st. petersburg','saint petersburg');
UPDATE fl_place_index SET sunbiz_city = 'CLEARWATER'         WHERE name_normalized = 'clearwater';
UPDATE fl_place_index SET sunbiz_city = 'BRANDON'            WHERE name_normalized = 'brandon';
UPDATE fl_place_index SET sunbiz_city = 'RIVERVIEW'          WHERE name_normalized = 'riverview';
UPDATE fl_place_index SET sunbiz_city = 'WESLEY CHAPEL'      WHERE name_normalized = 'wesley chapel';
UPDATE fl_place_index SET sunbiz_city = 'LAND O LAKES'       WHERE name_normalized = 'land o lakes';
UPDATE fl_place_index SET sunbiz_city = 'NEW PORT RICHEY'    WHERE name_normalized = 'new port richey';
UPDATE fl_place_index SET sunbiz_city = 'SPRING HILL'        WHERE name_normalized = 'spring hill';
UPDATE fl_place_index SET sunbiz_city = 'TARPON SPRINGS'     WHERE name_normalized = 'tarpon springs';
UPDATE fl_place_index SET sunbiz_city = 'PALM HARBOR'        WHERE name_normalized = 'palm harbor';
UPDATE fl_place_index SET sunbiz_city = 'LARGO'              WHERE name_normalized = 'largo';

-- Orlando / Central FL
UPDATE fl_place_index SET sunbiz_city = 'ORLANDO'            WHERE name_normalized = 'orlando';
UPDATE fl_place_index SET sunbiz_city = 'KISSIMMEE'          WHERE name_normalized = 'kissimmee';
UPDATE fl_place_index SET sunbiz_city = 'SANFORD'            WHERE name_normalized = 'sanford';
UPDATE fl_place_index SET sunbiz_city = 'ALTAMONTE SPRINGS'  WHERE name_normalized = 'altamonte springs';
UPDATE fl_place_index SET sunbiz_city = 'OVIEDO'             WHERE name_normalized = 'oviedo';
UPDATE fl_place_index SET sunbiz_city = 'WINTER PARK'        WHERE name_normalized = 'winter park';
UPDATE fl_place_index SET sunbiz_city = 'APOPKA'             WHERE name_normalized = 'apopka';
UPDATE fl_place_index SET sunbiz_city = 'OCALA'              WHERE name_normalized = 'ocala';
UPDATE fl_place_index SET sunbiz_city = 'GAINESVILLE'        WHERE name_normalized = 'gainesville';
UPDATE fl_place_index SET sunbiz_city = 'DAYTONA BEACH'      WHERE name_normalized = 'daytona beach';
UPDATE fl_place_index SET sunbiz_city = 'TALLAHASSEE'        WHERE name_normalized = 'tallahassee';
UPDATE fl_place_index SET sunbiz_city = 'THE VILLAGES'       WHERE name_normalized = 'the villages';

-- Southwest FL
UPDATE fl_place_index SET sunbiz_city = 'NAPLES'             WHERE name_normalized = 'naples';
UPDATE fl_place_index SET sunbiz_city = 'CAPE CORAL'         WHERE name_normalized = 'cape coral';
UPDATE fl_place_index SET sunbiz_city = 'FORT MYERS'         WHERE name_normalized IN ('fort myers','ft myers');
UPDATE fl_place_index SET sunbiz_city = 'BONITA SPRINGS'     WHERE name_normalized = 'bonita springs';
UPDATE fl_place_index SET sunbiz_city = 'SARASOTA'           WHERE name_normalized = 'sarasota';
UPDATE fl_place_index SET sunbiz_city = 'BRADENTON'          WHERE name_normalized = 'bradenton';
UPDATE fl_place_index SET sunbiz_city = 'VENICE'             WHERE name_normalized = 'venice' AND county_key = 'sarasota';
UPDATE fl_place_index SET sunbiz_city = 'PUNTA GORDA'        WHERE name_normalized = 'punta gorda';
UPDATE fl_place_index SET sunbiz_city = 'PORT CHARLOTTE'     WHERE name_normalized = 'port charlotte';

-- Panhandle
UPDATE fl_place_index SET sunbiz_city = 'PENSACOLA'          WHERE name_normalized = 'pensacola';
UPDATE fl_place_index SET sunbiz_city = 'DESTIN'             WHERE name_normalized = 'destin';
UPDATE fl_place_index SET sunbiz_city = 'FORT WALTON BEACH'  WHERE name_normalized IN ('fort walton beach','ft walton beach');
UPDATE fl_place_index SET sunbiz_city = 'PANAMA CITY'        WHERE name_normalized = 'panama city';
UPDATE fl_place_index SET sunbiz_city = 'PANAMA CITY BEACH'  WHERE name_normalized = 'panama city beach';

-- Other
UPDATE fl_place_index SET sunbiz_city = 'KEY WEST'           WHERE name_normalized = 'key west';
UPDATE fl_place_index SET sunbiz_city = 'LAKE CITY'          WHERE name_normalized = 'lake city';
UPDATE fl_place_index SET sunbiz_city = 'PALATKA'            WHERE name_normalized = 'palatka';
UPDATE fl_place_index SET sunbiz_city = 'FERNANDINA BEACH'   WHERE name_normalized = 'fernandina beach';

-- For any remaining entries without a sunbiz_city, fall back to UPPER(name)
UPDATE fl_place_index SET sunbiz_city = UPPER(name)
  WHERE sunbiz_city IS NULL AND place_type = 'city';

-- County-level entries don't need sunbiz_city (not used in city filter)
