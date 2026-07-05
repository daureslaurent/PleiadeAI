// Add gluetun VPN support to isolation profiles. When `network` is set to the new `vpn` mode, the
// profile's agent containers route through a dedicated gluetun (WireGuard) container. The operator
// uploads a standard WireGuard `.conf`; the backend parses it into gluetun's custom-provider env
// vars. The whole `.conf` (which contains the private key) is stored AES-256-GCM encrypted at rest
// in `vpn_conf_enc`. Existing profiles default to no VPN config (and keep their current network).

module.exports = {
  async up(db) {
    await db.collection('isolations').updateMany(
      { vpn_conf_enc: { $exists: false } },
      { $set: { vpn_conf_enc: null } },
    );
  },

  async down(db) {
    await db.collection('isolations').updateMany({}, { $unset: { vpn_conf_enc: '' } });
    // Any profiles left on the removed `vpn` mode fall back to bridge (NATed, no VPN dependency).
    await db
      .collection('isolations')
      .updateMany({ network: 'vpn' }, { $set: { network: 'bridge' } });
  },
};
