package com.hermesandroid.bridge.overlay

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.TextView

object StatusOverlay {
    private var overlayView: View? = null
    val isShowing: Boolean get() = overlayView != null

    fun show(context: Context) {
        if (overlayView != null) return

        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = 8
            y = 48
        }

        val tv = TextView(context).apply {
            text = "N●"
            textSize = 10f
            setTextColor(Color.parseColor("#4CAF50"))
            alpha = 0.7f
        }

        wm.addView(tv, params)
        overlayView = tv
    }

    fun hide(context: Context) {
        overlayView?.let {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            wm.removeView(it)
            overlayView = null
        }
    }

    fun setStatus(active: Boolean) {
        (overlayView as? TextView)?.apply {
            text = if (active) "N●" else "N○"
            setTextColor(Color.parseColor(if (active) "#4CAF50" else "#FF5722"))
        }
    }
}
