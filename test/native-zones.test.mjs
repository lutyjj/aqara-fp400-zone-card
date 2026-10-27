import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Zcl} from 'zigbee-herdsman';
import {BuffaloZcl} from 'zigbee-herdsman/dist/zspec/zcl/buffaloZcl.js';
import definition, {decodeNativeZones, nativeZoneRecord} from '../z2m/aqara-fp400.mjs';

const control = key => definition.toZigbee.find(c => c.key.includes(key));
const clusters = {};
// Only deviceAddCustomCluster touches this device; the other extends' configure steps fail on it, harmlessly.
for (const extend of definition.extend) {
    for (const configure of extend.configure ?? []) {
        Promise.resolve().then(() => configure({addCustomCluster: (name, cluster) => {clusters[name] = cluster;}})).catch(() => {});
    }
}
await new Promise(resolve => setImmediate(resolve));
const mask = Buffer.alloc(40); mask[0] = 0xc0; mask[39] = 0x01;
// Wire format of a zone record, as decoded on a sensor (Koenkk/zigbee2mqtt#33146):
// member count, then u8 id, enum8 type, octstr cells, bool enabled.
const record = id => `0400 20${id.toString(16).padStart(2, '0')} 3000 4128${mask.toString('hex')} 1001`.replaceAll(' ', '');

test('appendZone and updateZone send the zone as a ZCL struct', () => {
    for (const [command, id] of [['appendZone', 0x04], ['updateZone', 0x06]]) {
        const frame = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, 0x115f, 7, command,
            'aqaraFp400Config', {zone: nativeZoneRecord(3, mask)}, clusters).toBuffer();
        assert.equal(frame.toString('hex'), `155f1107${id.toString(16).padStart(2, '0')}${record(3)}`, command);
    }
});
test('removeZone sends the zone id', () => {
    const frame = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, 0x115f, 7, 'removeZone',
        'aqaraFp400Config', {zoneId: 2}, clusters).toBuffer();
    assert.equal(frame.toString('hex'), '155f11070802');
});
test('zone command replies without a manufacturer code still parse', () => {
    const buffer = Buffer.from('19070500', 'hex');
    const frame = Zcl.Frame.fromBuffer(0xfc0a, Zcl.Header.fromBuffer(buffer), buffer, clusters);
    assert.equal(frame.command.name, 'appendZoneResponse');
    assert.deepEqual(frame.payload, {status: 0});
});
test('attribute 16 decodes into zones', () => {
    const buffalo = new BuffaloZcl(Buffer.from(`4c0200${record(1)}${record(4)}`, 'hex'));
    const zones = decodeNativeZones(buffalo.read(Zcl.DataType.ARRAY, {}));
    assert.deepEqual(zones.map(({id, type, enabled}) => ({id, type, enabled})), [{id: 1, type: 0, enabled: true}, {id: 4, type: 0, enabled: true}]);
    assert.ok(zones.every(zone => zone.mask.equals(mask)));
});

// A sensor that keeps attribute 16 as zone commands change it.
function fakeSensor({ignoreCommands = false} = {}) {
    const zones = new Map();
    const sent = [];
    const endpoint = {
        read: async (cluster, [id]) => ({[id]: [...zones.entries()].map(([zoneId, cells]) => nativeZoneRecord(zoneId, cells))}),
        command: async (cluster, command, payload) => {
            sent.push(command);
            if (ignoreCommands) return;
            if (command === 'removeZone') zones.delete(payload.zoneId);
            else zones.set(payload.zone[0].elmVal, payload.zone[2].elmVal);
        },
    };
    return {zones, sent, meta: {device: {ieeeAddr: `native-${Math.random()}`, getEndpoint: () => endpoint}}};
}
const rect = {x_min: 300, x_max: 400, y_min: 0, y_max: 50};

test('a new zone is appended, an existing one updated, and clear removes it', async () => {
    const sensor = fakeSensor();
    let result = await control('native_zone_1_area').convertSet(null, 'native_zone_1_area', JSON.stringify(rect), sensor.meta);
    assert.equal(result.state.native_zone_1_mask_hex.slice(0, 2), 'c0');
    assert.equal(result.state.configured_zones, '[1]');
    result = await control('native_zone_1_area').convertSet(null, 'native_zone_1_area', {x_min: -400, x_max: -350, y_min: 0, y_max: 50}, sensor.meta);
    assert.equal(result.state.native_zone_1_mask_hex.slice(0, 4), '0001');
    result = await control('native_zone_1_area').convertSet(null, 'native_zone_1_area', 'clear', sensor.meta);
    assert.equal(result.state.native_zone_1_mask_hex, 'clear');
    assert.equal(result.state.configured_zone_count, 0);
    assert.deepEqual(sensor.sent, ['appendZone', 'updateZone', 'removeZone']);
});
test('clearing a zone the sensor does not have sends nothing', async () => {
    const sensor = fakeSensor();
    const result = await control('native_zone_2_area').convertSet(null, 'native_zone_2_area', 'clear', sensor.meta);
    assert.equal(result.state.native_zone_2_mask_hex, 'clear');
    assert.deepEqual(sensor.sent, []);
});
test('a zone the sensor does not take is reported as an error', async () => {
    const sensor = fakeSensor({ignoreCommands: true});
    await assert.rejects(control('native_zone_3_area').convertSet(null, 'native_zone_3_area', rect, sensor.meta), /not confirmed/);
});
