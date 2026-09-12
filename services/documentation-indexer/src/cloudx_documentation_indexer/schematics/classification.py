from collections import Counter

from .geometry import cut_component_interiors
from .native_pdf import NativePageGeometry, assign_native_text


def has_native_circuit_geometry(native: NativePageGeometry, scale: float) -> bool:
    """Require source symbol shapes with wire contacts before classifying a PDF."""
    symbols = [component.model_copy(deep=True) for component in native.board_components if component.kind != 'GND']
    if not symbols:
        return False
    _, terminals = cut_component_interiors(native.wires, symbols)
    contacts = Counter(terminal.component_id for terminal in terminals)
    connected = [component for component in symbols if contacts[component.id] >= 2]
    if any(component.kind in {'IntegratedCircuit', 'Connector', 'HierarchicalSheet'} and component.reference for component in connected):
        return True
    if any(component.kind == 'Op-Amp' and contacts[component.id] >= 3 for component in connected):
        return True
    assign_native_text(symbols, terminals, native.text, scale, native.wires)
    devices = [component for component in connected if component.kind != 'Rectangle']
    if len(devices) >= 2 and any(component.reference for component in devices):
        return True
    numbered_bodies = 0
    for component in connected:
        pins = [terminal.pin_number for terminal in terminals if terminal.component_id == component.id]
        numbers = [int(pin) for pin in pins if pin is not None and pin.isdecimal()]
        if len(numbers) >= max(4, len(pins) * 0.75) and len(set(numbers)) == len(numbers) and min(numbers) == 1 and max(numbers) <= len(numbers) + 1:
            numbered_bodies += 1
    return numbered_bodies >= 2
