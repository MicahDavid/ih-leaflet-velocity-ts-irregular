import Windy, { WindyOptions } from './windy';
import CanvasBound from './canvasBound'
import MapBound from './mapBound';
import Layer from "./layer";
import CanvasLayer from './L.CanvasLayer';

declare var L: any;

export default class VelocityLayer {
  private options: any;
  private _map: L.Map = null;
  private _canvasLayer: (CanvasLayer & L.Layer) = null;
  private _windy: Windy = null;
  private _context: any = null;
  private _displayTimeout: ReturnType<typeof setTimeout> = null;
  private _mapEvents: any = null
  private _mouseControl: any = null;
  private _paneName: string = null;

  constructor() {
    this.options = {
      displayValues: true,
      displayOptions: {
        velocityType: 'Velocity',
        position: 'bottomleft',
        emptyString: 'No velocity data',
        angleConvention: 'bearingCCW',
        speedUnit: 'm/s',
        heightUnit: 'ft',
        heightString: 'Height',
      },
      waveMode: false,
      maxVelocity: 10, // used to align color scale
      colorScale: null,
      onAdd: null,
      onRemove: null,
      data: null,
      paneName: "overlayPane",
    };
  }

  initialize(options: any) {
    L.Util.setOptions(this, options);
  }

  setOptions(options: any) {
    this.options = {...this.options, ...options};
    if (options.displayOptions) {
      this.options.displayOptions = {...this.options.displayOptions, ...options.displayOptions};
      this.initMouseHandler(true);
    }

    if (options.data) {
      this.options.data = options.data;
    }

    if (this._windy) {
      this._windy.setOptions(options);
      if (options.data) {
        this._windy.setData(options.data);
      }
      this.clearAndRestart();
    }

    (<any>this).fire("load");
  }

  onAdd(map: L.Map) {
    // determine where to add the layer
    this._paneName = this.options.paneName || "overlayPane";

    // Only create a pane if it truly doesn't exist (avoid recreating built-ins like 'tilePane')
    let pane = map.getPane ? map.getPane(this._paneName) : (map.getPanes() as any)[this._paneName];
    if (!pane && map.getPane) {
      pane = map.createPane(this._paneName);
    }

    // create canvas, add overlay control
    // We still pass the desired pane name in case the factory honors it
    this._canvasLayer = L.canvasLayer({ pane: this._paneName, paneName: this._paneName, zIndex: this.options.zIndex }).delegate(this);
    this._canvasLayer.addTo(map);

    // Force-move the canvas into the target pane to guarantee placement
    const targetPane =
      (map.getPane && map.getPane(this._paneName)) ||
      (map.getPanes && (map.getPanes() as any)[this._paneName]) ||
      map.getPanes().overlayPane;

    const canvasEl = this._canvasLayer.getCanvas && this._canvasLayer.getCanvas();
    if (canvasEl && targetPane && canvasEl.parentElement !== targetPane) {
      targetPane.appendChild(canvasEl);
      if (typeof this.options.zIndex === 'number') {
        canvasEl.style.zIndex = String(this.options.zIndex);
      }
    }

    this._map = map;

    if (this.options.onAdd)
      this.options.onAdd();
  }

  onRemove(map: any) {
    this.destroyWind();

    if (this.options.onRemove)
      this.options.onRemove();
  }

  setData(data: any) {
      this.options.data = data;

      if (this._windy) {
          this._windy.setData(data);
          this.clearAndRestart();
      }

    (<any>this).fire('load');
  }

  onDrawLayer() {
    if (!this._windy) {
      this.initWindy();
      return;
    }

    if (!this.options.data) {
      return;
    }

    if (this._displayTimeout) clearTimeout(this._displayTimeout);

    this._displayTimeout = setTimeout(() => {
      this.startWindy();
    }, 150); // showing velocity is delayed
  }

  private toggleEvents(bind: boolean = true) {
    if (this._mapEvents === null) {
      this._mapEvents = {
        'dragstart': () => {
          this._windy.stop();
        },
        'dragend': () => {
          this.clearAndRestart();
        },
        'zoomstart': () => {
          this._windy.stop();
        },
        'zoomend': () => {
          this.clearAndRestart();
        },
        'resize': () => {
          this.clearWind();
        }
      };
    }

    for (let e in this._mapEvents) {
      if (this._mapEvents.hasOwnProperty(e)) {
        this._map[bind ? 'on' : 'off'](e, this._mapEvents[e])
      }
    }
  }

  private initWindy() {
    const options: WindyOptions = {
      ...this.options,
      canvas: this._canvasLayer.getCanvas()
    }
    this._windy = new Windy(options);

    // prepare context global var, start drawing
    this._context = this._canvasLayer.getCanvas().getContext('2d');
    this._canvasLayer.getCanvas().classList.add("velocity-overlay");
    this.onDrawLayer();

    this.toggleEvents(true);

    this.initMouseHandler();
  }


  private initMouseHandler(unbind: boolean = false) {
    if (unbind) {
      this._map.removeControl(this._mouseControl);
      this._mouseControl = false;
    }

    if (!this._mouseControl && this.options.displayValues) {
      const options = this.options.displayOptions || {};
      this._mouseControl = L.control.velocity({
        ...options,
        waveMode: this.options.waveMode,
      });
      this._mouseControl.setWindy(this._windy);
      this._mouseControl.setOptions(this.options.displayOptions);
      this._mouseControl.addTo(this._map);
    }
  }

  private startWindy() {
    var bounds = this._map.getBounds();
    var size = this._map.getSize();

    // bounds, width, height, extent
    this._windy.start(
      new Layer(
        new MapBound(
          this._map,
          bounds.getNorthEast().lat,
          bounds.getNorthEast().lng,
          bounds.getSouthWest().lat,
          bounds.getSouthWest().lng
        ),
        new CanvasBound(0, 0, size.x, size.y)
      )

    );
  }

  private clearAndRestart() {
    if (this._context) this._context.clearRect(0, 0, 3000, 3000);
    if (this._windy) this.startWindy();
  }

  private clearWind() {
    if (this._windy) this._windy.stop();
    if (this._context) this._context.clearRect(0, 0, 3000, 3000);
  }

  private destroyWind() {
    if (this._displayTimeout)
      clearTimeout(this._displayTimeout);
    if (this._windy)
      this._windy.stop();
    if (this._context)
      this._context.clearRect(0, 0, 3000, 3000);
    if (this._mouseControl)
      this._map.removeControl(this._mouseControl);
    this._mouseControl = null;
    this._windy = null;
    this.toggleEvents(false);
    this._map.removeLayer(this._canvasLayer);
  }
}
