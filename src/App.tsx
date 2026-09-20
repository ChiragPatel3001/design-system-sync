import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Button,
  IconButton,
  FieldLabel,
  TextField,
  FormField,
  CheckboxControl,
  Checkbox,
  MenuItem,
  Menu,
  Link,
} from './index';
import {
  FavoriteIcon,
  MailIcon,
  HelpCircleIcon,
  ArrowRightCircleIcon,
  HomeIcon,
  ArrowUpRightIcon,
} from './demo-icons';
import './App.css';

/**
 * Demo gallery for the 10 POC components. Not part of the design system's
 * public API — a working Vite entry point that exercises every documented
 * variant/prop so `npm run build` also acts as a smoke test.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="demo-section">
      <h2>{title}</h2>
      <div className="demo-row">{children}</div>
    </section>
  );
}

export default function App() {
  const [checkedA, setCheckedA] = useState(true);
  const [checkedB, setCheckedB] = useState(false);
  const [selectedItem, setSelectedItem] = useState(1);

  return (
    <main className="demo-app">
      <h1>Design System POC</h1>
      <p className="demo-intro">
        Source of truth: <code>design-system-manifest.json</code>. Mapping:{' '}
        <code>design-system/registry.json</code>.
      </p>

      <Section title="Button">
        <Button variant="default">Default</Button>
        <Button variant="default" iconLeft={<FavoriteIcon />}>
          With icon
        </Button>
        <Button variant="default" disabled>
          Disabled
        </Button>
        <Button variant="outline">Outline</Button>
        <Button variant="outline" disabled>
          Outline disabled
        </Button>
        <Button variant="transparent">Transparent</Button>
        <Button variant="transparent" disabled>
          Transparent disabled
        </Button>
      </Section>

      <Section title="IconButton">
        <IconButton variant="default" icon={<FavoriteIcon />} aria-label="Favorite" />
        <IconButton variant="outline" icon={<FavoriteIcon />} aria-label="Favorite" />
        <IconButton variant="transparent" icon={<FavoriteIcon />} aria-label="Favorite" />
        <IconButton variant="default" icon={<FavoriteIcon />} aria-label="Favorite" disabled />
      </Section>

      <Section title="FieldLabel">
        <FieldLabel>Label</FieldLabel>
        <FieldLabel required>Label</FieldLabel>
        <FieldLabel required helpIcon={<HelpCircleIcon />}>
          Label
        </FieldLabel>
      </Section>

      <Section title="TextField">
        <TextField variant="default" placeholder="Placeholder" />
        <TextField variant="default" placeholder="Placeholder" disabled />
        <TextField variant="filled" defaultValue="Filled value" />
        <TextField
          variant="error"
          defaultValue="Invalid value"
          trailingIcon={<HelpCircleIcon />}
        />
      </Section>

      <Section title="FormField">
        <FormField
          label="Email"
          required
          helpIcon={<HelpCircleIcon />}
          leadingIcon={<MailIcon />}
          placeholder="john.doe@gmail.com"
          type="email"
          hint="We'll never share your email."
        />
        <FormField label="Disabled field" placeholder="Placeholder" disabled />
      </Section>

      <Section title="CheckboxControl">
        <CheckboxControl
          checked={checkedA}
          onChange={(event) => setCheckedA(event.target.checked)}
          aria-label="Unselected/Selected demo"
        />
        <CheckboxControl checked disabled aria-label="Disabled selected" readOnly />
        <CheckboxControl disabled aria-label="Disabled unselected" readOnly />
      </Section>

      <Section title="Checkbox">
        <Checkbox
          label="Accept terms"
          checked={checkedB}
          onChange={(event) => setCheckedB(event.target.checked)}
        />
        <Checkbox label="Disabled, unchecked" disabled readOnly />
        <Checkbox label="Disabled, checked" checked disabled readOnly />
      </Section>

      <Section title="MenuItem + Menu">
        <Menu>
          {['Overview', 'Analytics', 'Reports', 'Settings'].map((label, index) => (
            <MenuItem
              key={label}
              selected={selectedItem === index}
              icon={<ArrowRightCircleIcon />}
              onClick={() => setSelectedItem(index)}
            >
              {label}
            </MenuItem>
          ))}
          <MenuItem disabled icon={<ArrowRightCircleIcon />}>
            Disabled item
          </MenuItem>
        </Menu>
      </Section>

      <Section title="Link">
        <Link variant="default" href="#" iconLeft={<HomeIcon />}>
          Default
        </Link>
        <Link variant="active" href="#" iconRight={<ArrowUpRightIcon />}>
          Active
        </Link>
        <Link variant="disabled">Disabled</Link>
      </Section>
    </main>
  );
}
