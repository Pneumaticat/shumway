package flash.text.engine {
public final class SpaceJustifier extends TextJustifier {
    public function SpaceJustifier(locale:String = "en", lineJustification:String = "unjustified", letterSpacing:Boolean = false) {
      super(locale, lineJustification);
      notImplemented("SpaceJustifier");
    }
    public native function get letterSpacing():Boolean;
    public native function set letterSpacing(value:Boolean):void;
    public native function get minimumSpacing():Number;
    public native function set minimumSpacing(value:Number):void;
    public native function get optimumSpacing():Number;
    public native function set optimumSpacing(value:Number):void;
    public native function get maximumSpacing():Number;
    public native function set maximumSpacing(value:Number):void;
    public override function clone():TextJustifier { notImplemented("clone"); return null; }
  }
}
