/**
 * `react-native-vector-icons/<Set>` — an icon font, so there is nothing to run
 * off a device (T-1).
 *
 * A default export, because that is how the screens import it
 * (`import Feather from 'react-native-vector-icons/Feather'`). The element keeps
 * its props, so `name` survives into the tree: what a test wants to know about
 * an icon is which one was asked for, never what it looked like.
 */
import React from 'react';

const Icon = (props: Record<string, unknown>) => React.createElement('Icon', props);
Icon.displayName = 'Icon';

export default Icon;
