var async = require('async');
var co2lib = require('./static/app/co2eq');
var d3 = require('d3');
var express = require('express');
var http = require('http');
var Memcached = require('memcached');
var moment = require('moment');
var statsd = require('node-statsd');
var MongoClient = require('mongodb').MongoClient;

var app = express();
var server = http.Server(app);

// * Common
app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// * Cache
var memcachedClient = new Memcached(process.env['MEMCACHED_HOST']);

// * Database
var mongoCollection;
MongoClient.connect(process.env['MONGO_URL'], function(err, db) {
    if (err) throw (err);
    console.log('Connected to database');
    mongoCollection = db.collection('realtime');
    // Create indexes
    mongoCollection.createIndex(
        {datetime: -1, countryCode: 1},
        {unique: true},
        function(err, indexName) {
            if (err) console.error(err);
            else console.log('Database compound indexes created');
        }
    );
    mongoCollection.createIndexes(
        [
            { datetime: -1 },
            { countryCode: 1 },
        ],
        null,
        function (err, indexName) {
            if (err) console.error(err);
            else console.log('Database indexes created');
        }
    );
    server.listen(8000, function() {
        console.log('Listening on *:8000');
    });
});

// * Metrics
var statsdClient = new statsd.StatsD();
statsdClient.post = 8125;
statsdClient.host = process.env['STATSD_HOST'];
statsdClient.prefix = 'electricymap_api.';
statsdClient.socket.on('error', function(error) {
    return console.error('Error in StatsD socket: ', error);
});

// * Database methods
var countryCodes = [
    'AT',
    'BE',
    'BG',
    'BA',
    'BY',
    'CH',
    'CZ',
    'DE',
    'DK',
    'ES',
    'EE',
    'FI',
    'FR',
    'GB',
    'GR',
    'HR',
    'HU',
    'IE',
    'IS',
    'IT',
    'LT',
    'LU',
    'LV',
    'MD',
    'NL',
    'NO',
    'PL',
    'PT',
    'RO',
    'RU',
    'RS',
    'SK',
    'SI',
    'SE',
    'UA'
];
function parseDatabaseResults(result) {
    // Construct dict
    countries = {};
    result.forEach(function(d) {
        // Ignore errors: just filter
        if (!d) return;
        // Assign
        countries[d.countryCode] = d;
        // Default values
        if (!d.exchange) d.exchange = {};
        // Truncate negative production values
        d3.keys(d.production).forEach(function(k) {
            if (d.production[k] !== null)
                d.production[k] = Math.max(0, d.production[k]);
        });
    });
    // Average out import-exports between commuting pairs
    d3.keys(countries).forEach(function(o, i) {
        d3.keys(countries).forEach(function(d, j) {
            if (i < j) return;
            var netFlows = [
                countries[d].exchange[o] ? countries[d].exchange[o] : undefined,
                countries[o].exchange[d] ? -countries[o].exchange[d] : undefined
            ];
            var netFlow = d3.mean(netFlows);
            if (netFlow == undefined)
                return;
            countries[o].exchange[d] = -netFlow;
            countries[d].exchange[o] = netFlow;
        });
    });
    // Compute aggregates
    d3.values(countries).forEach(function (country) {
        country.maxProduction =
            d3.max(d3.values(country.production));
        country.totalProduction =
            d3.sum(d3.values(country.production));
        country.totalNetExchange =
            d3.sum(d3.values(country.exchange));
        country.maxExport =
            -Math.min(d3.min(d3.values(country.exchange)), 0) || 0;
    });

    return countries;
}
function computeCo2(countries) {
    var co2calc = co2lib.Co2eqCalculator();
    co2calc.compute(countries);
    d3.entries(countries).forEach(function(o) {
        o.value.co2intensity = co2calc.assignments[o.key];
    });
    d3.values(countries).forEach(function(country) {
        country.exchangeCo2Intensities = {};
        d3.keys(country.exchange).forEach(function(k) {
            country.exchangeCo2Intensities[k] =
                country.exchange[k] > 0 ? co2calc.assignments[k] : country.co2intensity;
        });
    });
    return countries;
}
function queryLastCountry(countryCode, callback) {
    var minDate = moment.utc().subtract(24, 'hours').toDate();
    return mongoCollection.findOne(
        { countryCode: countryCode, datetime: { $gte : minDate } },
        { sort: [['datetime', -1]] },
        callback);
}
function queryLastCountryBeforeDatetime(datetime, countryCode, callback) {
    var minDate = moment(datetime).subtract(24, 'hours').toDate();
    return mongoCollection.findOne(
        {
            countryCode: countryCode,
            datetime: { $lte: new Date(datetime) },
            datetime: { $gte: minDate }
        },
        { sort: [['datetime', -1]] },
        callback);
}
function queryLastValues(callback) {
    return async.parallel(countryCodes.map(function(k) {
        return function(callback) { return queryLastCountry(k, callback); };
    }), function (err, result) {
        return callback(err, computeCo2(parseDatabaseResults(result)));
    });
}
function queryLastValuesBeforeDatetime(datetime, callback) {
    return async.parallel(countryCodes.map(function(k) {
        return function(callback) { return queryLastCountryBeforeDatetime(datetime, k, callback); };
    }), function (err, result) {
        return callback(err, computeCo2(parseDatabaseResults(result)));
    });
}

// * Static
app.use(express.static('static'));
app.use(express.static('libs'));
// * Routes
app.get('/v1/wind', function(req, res) {
    statsdClient.increment('v1_wind_GET');
    res.header('Content-Encoding', 'gzip');
    res.sendFile(__dirname + '/data/wind.json.gz');
});
app.get('/v1/solar', function(req, res) {
    statsdClient.increment('v1_solar_GET');
    res.header('Content-Encoding', 'gzip');
    res.sendFile(__dirname + '/data/solar.json.gz');
});
app.get('/v1/production', function(req, res) {
    statsdClient.increment('v1_production_GET');
    var t0 = new Date().getTime();
    function returnObj(obj, cached) {
        if (cached) statsdClient.increment('v1_production_GET_HIT_CACHE');
        var deltaMs = new Date().getTime() - t0;
        res.json({status: 'ok', data: obj, took: deltaMs + 'ms', cached: cached});
        statsdClient.timing('production_GET', deltaMs);
    }
    if (req.query.datetime) {
        queryLastValuesBeforeDatetime(req.query.datetime, function (err, result) {
            if (err) {
                statsdClient.increment('production_GET_ERROR');
                console.error(err);
                res.status(500).json({error: 'Unknown database error'});
            } else {
                returnObj(result, false);
            }
        });
    } else {
        memcachedClient.get('production', function (err, data) {
            if (err) { console.error(err); }
            if (data) returnObj(data, true);
            else {
                queryLastValues(function (err, result) {
                    if (err) {
                        statsdClient.increment('production_GET_ERROR');
                        console.error(err);
                        res.status(500).json({error: 'Unknown database error'});
                    } else {
                        memcachedClient.set('production', result, 5 * 60, function(err) {
                            if (err) console.error(err);
                        });
                        returnObj(result, false);
                    }
                });
            }
        });
    }
});
app.get('/v1/co2', function(req, res) {
    statsdClient.increment('v1_co2_GET');
    var t0 = new Date().getTime();
    var countryCode = req.query.countryCode;

    function onCo2Computed(err, countries) {
        if (err) {
            statsdClient.increment('co2_GET_ERROR');
            console.error(err);
            res.status(500).json({error: 'Unknown error'});
        } else {
            var deltaMs = new Date().getTime() - t0;
            responseObject = {
                status: 'ok',
                countryCode: countryCode,
                co2intensity: countries[countryCode].co2intensity,
                unit: 'gCo2eq/kWh',
                data: countries[countryCode]
            };
            responseObject.took = deltaMs + 'ms';
            res.json(responseObject);
            statsdClient.timing('co2_GET', deltaMs);
        }
    }

    if ((req.query.lon && req.query.lat) || countryCode) {
        if (!countryCode) {
            // Geocode
            http.get(
                'http://maps.googleapis.com/maps/api/geocode/json?latlng=' + req.query.lat + ',' + req.query.lon,
                function (geocoderResponse) {
                    var body = '';
                    geocoderResponse.on('data', function(chunk) { body += chunk; });
                    geocoderResponse.on('end', function() {
                        var obj = JSON.parse(body).results[0].address_components
                            .filter(function(d) { return d.types.indexOf('country') != -1; });
                        if (obj.length) {
                            countryCode = obj[0].short_name;
                            queryLastValues(onCo2Computed);
                        }
                        else {
                            console.error('Geocoder returned no usable results');
                            res.status(500).json({error: 'Error while geocoding'});
                        }
                    });
                }
            ).on('error', (e) => {
                console.error(`Error while geocoding: ${e.message}`);
                res.status(500).json({error: 'Error while geocoding'});
            });
        } else {
            queryLastValues(onCo2Computed);
        }
    } else {
        res.status(400).json({'error': 'Missing arguments "lon" and "lat" or "countryCode"'})
    }
});
app.get('/health', function(req, res) {
    statsdClient.increment('health_GET');
    var EXPIRATION_SECONDS = 30 * 60.0;
    mongoCollection.findOne({}, {sort: [['datetime', -1]]}, function (err, doc) {
        if (err) {
            console.error(err);
            res.status(500).json({error: 'Unknown database error'});
        } else {
            var deltaMs = new Date().getTime() - new Date(doc.datetime).getTime();
            if (deltaMs < 0 && deltaMs > EXPIRATION_SECONDS * 1000.0)
                res.status(500).json({error: 'Database is empty or last measurement is too old'});
            else
                res.json({status: 'ok'});
        }
    });
});
