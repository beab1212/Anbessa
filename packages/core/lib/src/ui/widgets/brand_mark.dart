import 'package:flutter/widgets.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// The Anbessa app icon ("Lion Grille": a car front whose headlights, nose and grille read as a
/// lion's face) on its amber rounded square. Same artwork as the launcher icons
/// (assets/brand/anbessa_icon.svg).
class AnbessaMark extends StatelessWidget {
  const AnbessaMark({super.key, this.size = 40});
  final double size;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: SvgPicture.asset(
          'assets/brand/anbessa_icon.svg',
          package: 'ride_app_core',
          width: size,
          height: size,
        ),
      );
}
