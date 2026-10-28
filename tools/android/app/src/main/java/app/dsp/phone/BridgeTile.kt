package app.dsp.phone

import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Плитка в шторке: мост включён / выключен одним касанием. */
class BridgeTile : TileService() {
    override fun onStartListening() { paint() }

    override fun onClick() {
        if (BridgeService.up) BridgeService.stop(this) else BridgeService.start(this)
        BridgeService.up = !BridgeService.up
        paint()
    }

    private fun paint() {
        val t = qsTile ?: return
        t.state = if (BridgeService.up) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.label = "DSP bridge"
        t.updateTile()
    }
}
