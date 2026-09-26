"""Compiler regressions only; actual Squid and host network behavior are separate gates."""
import copy
import ipaddress
import unittest

import egress_policy as policy


def example():
    return dict(listen_address="10.77.0.1", client_address="10.77.0.2", listen_port=3128,
                origins=[dict(scheme="http", host="alpha.example", port=8080),
                         dict(scheme="https", host="beta.example", port=8443)],
                forbidden_networks=["93.184.216.36/32", "2606:4700:4700::1111/128"])


class Compiler(unittest.TestCase):
    def test_tuple_scope_does_not_form_cross_product_or_admit_ftp(self):
        text = policy.compile_egress_policy(example())
        allows = [line for line in text.splitlines() if line.startswith("http_access allow ")]
        self.assertEqual(allows, [
            "http_access allow browser_client origin0_domain origin0_exact origin0_port http_protocol !connect_method",
            "http_access allow browser_client origin1_domain origin1_exact origin1_port connect_method",
        ])
        self.assertIn("acl http_protocol proto HTTP\n", text)
        self.assertIn("acl origin0_domain dstdomain -n alpha.example\n", text)
        self.assertIn(r"acl origin0_exact dstdom_regex -n ^alpha\.example$" + "\n", text)
        self.assertIn("acl browser_client src 10.77.0.2/32\n", text)
        self.assertLess(text.index("http_access deny blocked_dst"), text.index(allows[0]))
        self.assertTrue(text.endswith("http_access deny all\n"))

    def test_injection_numeric_and_noncanonical_names_are_rejected(self):
        names = ("127.0.0.1", "127.1", "0x7f000001", "0177.0.0.1", "2130706433",
                 "[::1]", "localhost", "a.localhost", "a.example\nhttp_access allow all",
                 "a.example\r", "a.example\x00", ".a.example", "*.example", "a..example",
                 "A.example", "a.example.", "user@a.example", "a.example/path", "a.example?x",
                 "a.example#x", "a%2eexample", "xn--a.example", "测.example", "-a.example",
                 "single", "a" * 64 + ".example", None, True, ["a.example"])
        for name in names:
            with self.subTest(name=name):
                value = example();value["origins"][0]["host"] = name
                with self.assertRaises(policy.EgressPolicyError):policy.compile_egress_policy(value)

    def test_closed_schema_and_limits(self):
        changes = [None, [], {}, {**example(), "include": "/etc/squid.conf"},
                   {**example(), "listen_address": "0.0.0.0"},
                   {**example(), "listen_address": "127.0.0.1"},
                   {**example(), "client_address": "10.77.0.1"},
                   {**example(), "client_address": "10.077.0.2"},
                   {**example(), "listen_port": True}, {**example(), "listen_port": 80},
                   {**example(), "origins": []}, {**example(), "origins": ()},
                   {**example(), "origins": example()["origins"] * 6},
                   {**example(), "origins": [example()["origins"][0]] * 2},
                   {**example(), "forbidden_networks": ["10.0.0.1/8"]},
                   {**example(), "forbidden_networks": ["::ffff:0:0/96"]},
                   {**example(), "forbidden_networks": ["10.0.0.0/8\nhttp_access allow all"]},
                   {**example(), "forbidden_networks": ["10.0.0.0/8"] * 33}]
        for field, value in (("scheme", "ftp"), ("scheme", []), ("port", True),
                             ("port", 0), ("port", 65536), ("extra", "x")):
            item = example();item["origins"][0][field] = value;changes.append(item)
        for value in changes:
            with self.subTest(value=value):
                with self.assertRaises(policy.EgressPolicyError):policy.compile_egress_policy(value)

    def test_input_is_not_modified_and_results_are_deterministic(self):
        value = example();before = copy.deepcopy(value)
        self.assertEqual(policy.compile_egress_policy(value), policy.compile_egress_policy(value))
        self.assertEqual(value, before)

    def test_private_and_special_addresses_have_explicit_denials(self):
        networks = [ipaddress.ip_network(n) for n in policy.BLOCKED]
        for address in ("0.1.2.3", "10.4.3.2", "100.64.0.2", "127.0.0.1", "169.254.169.254",
                        "172.16.0.1", "192.168.0.1", "198.18.0.1", "203.0.113.1", "224.0.0.1",
                        "255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "ff02::1",
                        "64:ff9b::a00:1", "64:ff9b:1::1", "100:0:0:1::1", "2001::1",
                        "2001:db8::1", "2002:a00:1::", "3fff::1", "5f00::1", "8000::1"):
            item = ipaddress.ip_address(address)
            with self.subTest(address=address):
                self.assertTrue(any(item.version == n.version and item in n for n in networks))
        # Squid normalizes ordinary IPv4 into this family; forbidding it wholesale
        # would deny every positive IPv4 request despite a passing naive Python model.
        for address in ("93.184.216.34", "2606:4700:4700::1111", "::ffff:5db8:d822"):
            item = ipaddress.ip_address(address)
            self.assertFalse(any(item.version == n.version and item in n for n in networks))


if __name__ == "__main__":
    unittest.main()
