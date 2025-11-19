import Vector from "./vector";
import Grid from "./grid";
import IrregularGrid from "./irregularGrid";
import ColorScale from "./colorScale";
import Particule from "./particle";
import AnimationBucket from "./animationBucket";
import Layer from "./layer";

export interface WindyOptions {
  canvas: any;
  data: any;
  colorScale: string[];
  maxVelocity: number;
  minVelocity: number;
  velocityScale: number;
  particleAge: number;
  particleMultiplier: number;
  particlelineWidth: number;
  frameRate: number;
  opacity: number;
  waveMode: boolean;
  wavesParticlesSeparation: number;
}
export default class Windy {

  private grid: any;
  private isIrregularGrid: boolean = false;
  private λ0: number;
  private φ0: number;
  private Δλ: number;
  private Δφ: number;
  private ni: number;
  private nj: number;
  private canvas: any = null;
  private colorScale: ColorScale;
  private velocityScale: number;
  private particleMultiplier = 1 / 300;
  private particleAge: number;
  private particleLineWidth: number;
  private autoColorRange = false;
  private opacity: number;
  private waveMode: boolean;
  private wavesParticlesSeparation: number; // separation of wave particles

  private layer: Layer;
  private particules: Particule[] = [];
  private animationBucket: AnimationBucket;
  private context2D: any;
  private animationLoop: any = null;
  private frameTime: number;
  private then = 0;


  constructor(options: WindyOptions) {
    console.log("[Velocity Debug] Windy.constructor received debug:", (options as any).debug, "hasData:", !!options.data);
    this.setOptions(options);
    this.canvas = options.canvas;
    if (options.data) {
      this.setData(options.data);
    }
  }

  public setOptions(options: WindyOptions) {
    if (options.minVelocity === undefined && options.maxVelocity === undefined) {
      this.autoColorRange = true;
    }
    this.colorScale = new ColorScale(options.minVelocity || 0, options.maxVelocity || 10, options.colorScale);
    this.velocityScale = options.velocityScale || 0.01;
    this.particleAge = options.particleAge || 64;
    this.opacity = +options.opacity || 0.97

    this.particleMultiplier = options.particleMultiplier || 1 / 300;
    this.particleLineWidth = options.particlelineWidth || 1;
    const frameRate = options.frameRate || 15;
    this.frameTime = 1000 / frameRate;

    if (options.waveMode) {
      this.waveMode = options.waveMode;
      this.particleAge = options.particleAge  || 200;
      this.particleMultiplier = options.particleMultiplier || 1 / 7000;
      this.velocityScale = 0.0045;
      this.wavesParticlesSeparation = options.wavesParticlesSeparation || 3.5;
    }

    // Debug hooks
    // @ts-ignore - allow optional debug fields in options
    this["debug"] = (options as any).debug === true;
    // @ts-ignore
    this["forceVelocityScale"] = (options as any).forceVelocityScale;

    // One-time confirmation that debug is on
    // @ts-ignore
    if (this["debug"]) {
      console.log("[Velocity Debug] setOptions -> debug enabled");
    }
  }

  public get particuleCount() {
    const particuleReduction = ((/android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i).test(navigator.userAgent)) ? (Math.pow(window.devicePixelRatio, 1 / 3) || 1.6) : 1;
    return Math.round(this.layer.canvasBound.width * this.layer.canvasBound.height * this.particleMultiplier) * particuleReduction;
  }

  /**
   * Load data
   * @param data
   */
  public setData(data: any) {
    let uData: any = null;
    let vData: any = null;
    let waveHeight: any = null;
    const grid: Vector[] = [];

      if (Array.isArray(data)) {
          data.forEach((record) => {
              switch (`${record.header.parameterCategory},${record.header.parameterNumber}`) {
                  case "1,2":
                  case "2,2":
                      uData = record;
                      break;
                  case "1,3":
                  case "2,3":
                      vData = record;
                      break;
                  default:
                      waveHeight = record;
              }
          });
      }

    if (!uData || !vData) {
      console.warn("Data are not correct format");
      console.log("Data are not correct format");
      return;
    }

    uData.data.forEach((u: number, index: number) => {
      const wh = waveHeight !== null ? waveHeight.data[index] : undefined;
      grid.push(new Vector(u, vData.data[index], wh));
    })


      // Check if data contains converted lat/lng arrays (from pixel coordinates)
      if (data.latitudes && data.longitudes) {
          this.isIrregularGrid = true;
          console.warn('irregular grid detected')

          // Extract u, v, and optional wave height data
          //const uValues = data.u || data.uData || [];
          //const vValues = data.v || data.vData || [];
          //const whValues = data.waveHeight || [];

          // Build vector grid
          // NOTE: grid was already filled above from uData/vData.
          // Avoid pushing duplicates here.

          // Determine grid dimensions with explicit typing for sort
          const uniqueLng = data.longitudes
          const uniqueLat = data.latitudes
          const width = uniqueLng.length;
          const height = uniqueLat.length;

          // Use IrregularGrid for Web Mercator data
          this.grid = new IrregularGrid(
              grid,
              uniqueLat,
              uniqueLng
          );

          // Handle International Date Line crossing for bounds
          const longitudes = data.longitudes;
          const crossesIDL = this.detectDateLineCrossing(longitudes);

          if (crossesIDL) {
              // Normalize longitudes to 0-360 range for IDL crossing case
              const normalizedLongs = longitudes.map((lng: number) => lng < 0 ? lng + 360 : lng);
              this.λ0 = Math.min(...normalizedLongs);
              const λ1 = Math.max(...normalizedLongs);
              this.Δλ = width > 1 ? (λ1 - this.λ0) / (width - 1) : 1;

              //console.log('Normalized longitude range:', this.λ0, 'to', λ1);
              //console.log('Δλ:', this.Δλ);

              // Convert back to -180/180 range if needed
              if (this.λ0 > 180) {
                  this.λ0 -= 360;
              }

          } else {
              // Standard case - no IDL crossing
              this.λ0 = Math.min(...longitudes);
              const λ1 = Math.max(...longitudes);
              this.Δλ = width > 1 ? (λ1 - this.λ0) / (width - 1) : 1;
          }

          // Set bounds for the irregular grid
          this.φ0 = Math.max(...data.latitudes);
          this.ni = width;
          this.nj = height;

          // Set approximate deltas (not used in irregular grid interpolation)
          this.Δλ = width > 1 ? (Math.max(...data.longitudes) - this.λ0) / (width - 1) : 1;
          this.Δφ = height > 1 ? (this.φ0 - Math.min(...data.latitudes)) / (height - 1) : 1;

      } else if (uData && vData) {
          // Original format - backward compatibility
          this.isIrregularGrid = false;

          uData.data.forEach((u: number, index: number) => {
              const wh = waveHeight !== null ? waveHeight.data[index] : undefined;
              grid.push(new Vector(u, vData.data[index], wh));
          });

          this.grid = new Grid(
              grid,
              uData.header.la1,
              uData.header.lo1,
              uData.header.dy,
              uData.header.dx,
              uData.header.ny,
              uData.header.nx
          );

          this.λ0 = uData.header.lo1;
          this.φ0 = uData.header.la1;
          this.Δλ = uData.header.dx;
          this.Δφ = uData.header.dy;
          this.ni = uData.header.nx;
          this.nj = uData.header.ny;

          // Build 2D grid structure for regular grids only
          let p = 0;
          const isContinuous = Math.floor(this.ni * this.Δλ) >= 360;

          for (let j = 0; j < this.nj; j++) {
              const row = [];
              for (let i = 0; i < this.ni; i++, p++) {
                  row[i] = this.grid.data[p];
              }
              if (isContinuous) {
                  row.push(row[0]);
              }
              this.grid[j] = row;
          }
      } else {
          console.warn("Data format not recognized");
          return;
      }

      // Debug: verify grid dimensions and key flags
      // @ts-ignore
      if (this["debug"]) {
        const expected = (this.ni || 0) * (this.nj || 0);
        console.log("[Velocity Debug] setData -> isIrregularGrid:", this.isIrregularGrid, "ni:", this.ni, "nj:", this.nj, "grid.length:", grid.length, "expected:", expected);
        if (expected && grid.length !== expected) {
          console.warn("[Velocity Debug] grid size mismatch: data != lat*lon");
        }
      }

      // Debug intensity range
      // @ts-ignore
      if (this["debug"]) {
        try {
          const range = this.grid.valueRange ? this.grid.valueRange : null;
          if (range) {
            console.log("[Velocity Debug] intensity range:", range);
          } else {
            // Fallback manual range
            let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
            grid.forEach((v: any) => {
              const s = Math.sqrt(v.u * v.u + v.v * v.v);
              min = Math.min(min, s); max = Math.max(max, s);
            });
            console.log("[Velocity Debug] computed intensity range:", [min, max]);
          }
          console.log("[Velocity Debug] grid size:", this.nj, "x", this.ni, "=", this.ni * this.nj);
        } catch (e) {
          console.warn("[Velocity Debug] range failure:", e);
        }
      }
  }

  /* Get interpolated grid value from Lon/Lat position
* @param λ {Float} Longitude
* @param φ {Float} Latitude
* @returns {Object}
*/
  public interpolate(λ: number, φ: number): any {
    if (!this.grid) {
      return null;
    }

      // IrregularGrid has its own get method
      if (this.isIrregularGrid) {
          return this.grid.get(λ, φ);
      }

    var i = this.floorMod(λ - this.λ0, 360) / this.Δλ; // calculate longitude index in wrapped range [0, 360)
    var j = (this.φ0 - φ) / this.Δφ; // calculate latitude index in direction +90 to -90

    var fi = Math.floor(i);
    var ci = fi + 1;
    var fj = Math.floor(j);
    var cj = fj + 1;
    var row = this.grid[fj];//Dont know why he dosent found any row ERRRROR
    if (row) {
      var g00 = row[fi];
      var g10 = row[ci];
      if (this.isValue(g00) && this.isValue(g10) && (row = this.grid[cj])) {
        var g01 = row[fi];
        var g11 = row[ci];
        if (this.isValue(g01) && this.isValue(g11)) {
          // All four points found, so interpolate the value.
          return this.bilinearInterpolateVector(i - fi, j - fj, g00, g10, g01, g11);
        }
      }
    }
    return null;
  };

  public start(layer: Layer) {
    this.context2D = this.canvas.getContext("2d");
    this.context2D.lineWidth = this.particleLineWidth;
    const fadeOpacity = this.waveMode ? 0.75 : this.opacity;
    this.context2D.fillStyle = `rgba(0, 0, 0, ${fadeOpacity})`;
    this.context2D.globalAlpha = this.waveMode ? 0.2 : 0.6;

    this.layer = layer;
    this.animationBucket = new AnimationBucket(this.colorScale);

    this.particules.splice(0, this.particules.length);
    for (let i = 0; i < this.particuleCount; i++) {
      this.particules.push(this.layer.canvasBound.getRandomParticule(this.particleAge));
    }

    this.then = new Date().getTime();

    // @ts-ignore
    if (this["debug"]) {
      console.log("[Velocity Debug] start -> particles:", this.particuleCount, "waveMode:", this.waveMode, "opacity:", this.opacity, "lineWidth:", this.particleLineWidth);
    }

    this.frame();
  }

  public stop() {
    this.particules.splice(0, this.particules.length);
    this.animationBucket?.clear();
    if (this.animationLoop) {
      clearTimeout(this.animationLoop);
      cancelAnimationFrame(this.animationLoop);
      this.animationLoop = null;
    }
  }

  private floorMod(a: number, n: number) {
    return a - n * Math.floor(a / n);
  };

  private isValue(x: any) {
    return x !== null && x !== undefined;
  };

    /**
     * Detect if longitudes cross the International Date Line
     * @param longitudes Array of longitude values
     * @returns true if the data crosses the IDL
     */
    private detectDateLineCrossing(longitudes: number[]): boolean {
        if (longitudes.length < 2) return false;

        let hasPositive = false;
        let hasNegative = false;

        for (const lng of longitudes) {
            if (lng > 90) hasPositive = true;
            if (lng < -90) hasNegative = true;

            // If we have both far-east positive and far-west negative values,
            // it's likely crossing the IDL
            if (hasPositive && hasNegative) {
                return true;
            }
        }

        return false;
    }

  private bilinearInterpolateVector(x: number, y: number, g00: any, g10: any, g01: any, g11: any) {
    var rx = (1 - x);
    var ry = (1 - y);
    var a = rx * ry, b = x * ry, c = rx * y, d = x * y;
    var u = g00.u * a + g10.u * b + g01.u * c + g11.u * d;
    var v = g00.v * a + g10.v * b + g01.v * c + g11.v * d;
    var wh = g00.waveHeight * a + g10.waveHeight * b + g01.waveHeight * c + g11.waveHeight * d;
    if (this.waveMode) {
      return [u, v, wh];
    }
    return [u, v, Math.sqrt(u * u + v * v)];
  };

  private getParticuleWind(p: Particule): Vector {
    const lngLat = this.layer.canvasToMap(p.x, p.y);

    // Wrap longitude into [-180, 180] to handle world copies at low zoom
    const λWrapped = ((lngLat[0] + 180) % 360 + 360) % 360 - 180;

    const wind = this.grid.get(λWrapped, lngLat[1]);
    p.intensity = wind.intensity;
    p.waveHeight = wind.waveHeight;
    const mapArea = this.layer.mapBound.height * this.layer.mapBound.width;

    // @ts-ignore
    const forced = this["forceVelocityScale"];
    var velocityScale = forced != null ? forced : (this.velocityScale * Math.pow(mapArea, 0.4));

    this.layer.distort(λWrapped, lngLat[1], p.x, p.y, velocityScale, wind);

    // Optional debug sampling
    // @ts-ignore
    if (this["debug"]) {
      if (!wind || (!isFinite(wind.u) || !isFinite(wind.v) || (Math.abs(wind.u) + Math.abs(wind.v) === 0))) {
        if (Math.random() < 0.001) {
          console.log("[Velocity Debug] zero/invalid wind at", { lng: λWrapped, lat: lngLat[1] });
        }
      }
    }
    return wind;
  }



  private frame() {
    this.animationLoop = requestAnimationFrame(() => {
      this.frame()
    });
    var now = new Date().getTime();
    var delta = now - this.then;
    if (delta > this.frameTime) {
      this.then = now - (delta % this.frameTime);
      this.evolve();
      this.draw();
    }
  }

  private evolve() {
    this.animationBucket?.clear();
    this.particules.forEach((p: Particule) => {
      p.grow();
      if (p.isDead) {
        this.layer.canvasBound.resetParticule(p);
      }
      const wind = this.getParticuleWind(p);
      this.animationBucket.add(p, wind);
    });
  }

  private draw() {
    if (this.waveMode) {
      this.drawWaves();
    } else {
      this.drawWind();
    }
  }

  private drawWind() {
    this.context2D.globalCompositeOperation = "destination-in";
    this.context2D.fillRect(
      this.layer.canvasBound.xMin,
      this.layer.canvasBound.yMin,
      this.layer.canvasBound.width,
      this.layer.canvasBound.height
    );
    // Fade existing particle trails.
    this.context2D.globalCompositeOperation = "lighter";
    this.context2D.globalAlpha = this.opacity === 0 ? 0 : this.opacity * 0.9;

    this.animationBucket.draw(this.context2D);
  }

  private verticalOffset(offset: number, maxOffset: number): number {
    return 7 * Math.cos((Math.abs(offset) / maxOffset) * (Math.PI / 2));
  }

  private generateOffsets(count: number): number[] {
    let numDivisions = (count - 1) / 2;
      let offsets = [];
      for (let i = -numDivisions; i <= numDivisions; i++) {
        offsets.push(i);
      }
      return offsets;
  }

  private calculateWaveParticles(waveHeight: number): number {
    if (waveHeight < 0.5) return 4;
    if (waveHeight < 0.7) return 5;
    if (waveHeight < 1) return 6;
    if (waveHeight < 1.5) return 7;
    if (waveHeight < 2) return 8;
    if (waveHeight < 2.5) return 9;
    if (waveHeight < 3) return 10;
    if (waveHeight < 4) return 10;
    if (waveHeight < 10) return 11;
    if (waveHeight < 20) return 12;
    if (waveHeight < 30) return 13;
    return 14;
  }



  private drawWaves() {
    const g = this.context2D;
    g.globalCompositeOperation = "destination-in";
    g.fillRect(
      this.layer.canvasBound.xMin,
      this.layer.canvasBound.yMin,
      this.layer.canvasBound.width,
      this.layer.canvasBound.height
    );
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = this.opacity;

    this.animationBucket.getBuckets().forEach((bucket: Particule[], i: number) => {
      if (bucket.length > 0) {
        g.beginPath();
        g.strokeStyle = this.colorScale.colorAt(i);

        bucket.forEach((particle: Particule) => {
          const dx = particle.xt - particle.x;
          const dy = particle.yt - particle.y;
          const mag = Math.sqrt(dx * dx + dy * dy);

          const perpX = mag ? -dy / mag : 0;
          const perpY = mag ? dx / mag : 0;
          const normX = mag ? dx / mag : 0;
          const normY = mag ? dy / mag : 0;

          const waveHeight =  particle.waveHeight || 1;
          const numWaveParticles = this.calculateWaveParticles(waveHeight);
          const offsets = this.generateOffsets(numWaveParticles);
          const SEPARATION = this.wavesParticlesSeparation;
          const maxOffset = 3.5;

          offsets.forEach((offset) => {

              const shiftX = perpX * offset * SEPARATION;
              const shiftY = perpY * offset * SEPARATION;

              const vOff = this.verticalOffset(offset, maxOffset);

              const startX = particle.x + shiftX + normX * vOff;
              const startY = particle.y + shiftY + normY * vOff;
              const endX = particle.xt + shiftX + normX * vOff;
              const endY = particle.yt + shiftY + normY * vOff;

              g.moveTo(startX, startY);
              g.lineTo(endX, endY);
          });

          particle.x = particle.xt;
          particle.y = particle.yt;
        });

        g.stroke();
      }
    });
  }

}
